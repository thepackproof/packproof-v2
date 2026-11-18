// Read-only collection of the private inputs consumed by connect-runtime-release-runner.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { TARGET, hash } from './backend-deployment-plan.mjs';
import { observeServices, verifyService } from './connect-hosted-owner-task.mjs';
import { hostedCollectorTarget } from './reconstruction-v11-release-review.mjs';

const exec = promisify(execFile);
const cluster = hostedCollectorTarget.clusterArn;
const endpoint = 'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const origin = 'https://thepackproof.com';
const check = (ok, code) => { if (!ok) throw Error('HOSTED_OBSERVE_' + code); };
const env = c => Object.fromEntries((c.environment ?? []).map(x => [x.name, x.value]));

async function readDiscovery() {
  const temp = await mkdtemp(join(tmpdir(), 'connect-runtime-observe-'));
  try {
    const file = join(temp, 'discovery.json');
    await exec(process.execPath, [fileURLToPath(new URL('../backend-control-plane-readonly.mjs', import.meta.url)), file],
      { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(await readFile(file, 'utf8'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// All lists in this *network topology* are sets (subnets, ALBs, security-group rules, etc.).
// Their AWS response order can change between the worker and API reads.
function canonicalNetwork(value) {
  if (Array.isArray(value)) return value.map(canonicalNetwork).sort((a,b) => {
    const lhs=hash(a), rhs=hash(b);
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,canonicalNetwork(v)]));
  return value;
}

function runtimeTopology(discovery, api) {
  const config = api.express.activeConfigurations[0];
  check(discovery.readOnly && discovery.account === TARGET.account && discovery.region === TARGET.region &&
    discovery.service?.serviceArn === TARGET.serviceArn && discovery.service.taskDefinition === api.service.taskDefinition &&
    discovery.express?.activeConfigurations?.length === 1 &&
    discovery.express.activeConfigurations[0].configurationSha256 === hash(config), 'TOPOLOGY_REVISION_CHANGED');
  const required = [
    'describe-express-gateway-service','describe-service-revisions','describe-target-groups',
    'describe-load-balancers','describe-load-balancer-attributes','describe-security-groups','describe-subnets'
  ];
  if (discovery.networkEvidence?.interfaceLookupNeeded) required.push('describe-network-interfaces');
  for (const name of required) {
    const calls = discovery.calls.filter(c => c.operation === name);
    check(calls.length && calls.every(c => c.status === 'SUCCESS'), 'TOPOLOGY_CALL_INCOMPLETE');
  }
  const trustedProxies = discovery.express.activeConfigurations[0].primaryContainer.trustedProxies;
  const {loadBalancers,targetGroups,securityGroups,subnets}=discovery;
  check(trustedProxies?.configured === true && typeof trustedProxies.value === 'string' && trustedProxies.value.trim() &&
    [loadBalancers,targetGroups,securityGroups,subnets].every(items => Array.isArray(items) && items.length > 0),
  'TOPOLOGY_MISSING');
  return canonicalNetwork({trustedProxies,loadBalancers,targetGroups,securityGroups,subnets});
}

function probeNetwork(service) {
  const network = service.networkConfiguration?.awsvpcConfiguration;
  check(service.clusterArn === cluster && network && ['ENABLED','DISABLED'].includes(network.assignPublicIp) &&
    network.subnets?.length && network.subnets.every(id => /^subnet-[a-f0-9]+$/.test(id)) &&
    network.securityGroups?.length && network.securityGroups.every(id => /^sg-[a-f0-9]+$/.test(id)), 'PROBE_NETWORK');
  const strategy = service.capacityProviderStrategy;
  check(strategy?.length ? strategy.every(s => ['FARGATE','FARGATE_SPOT'].includes(s.capacityProvider)) :
    service.launchType === 'FARGATE', 'PROBE_CAPACITY');
  return {
    clusterArn: cluster, networkConfiguration: structuredClone(service.networkConfiguration),
    ...(strategy?.length ? {capacityProviderStrategy: structuredClone(strategy)} : {}),
    ...(service.platformVersion ? {platformVersion:service.platformVersion} : {})
  };
}

export async function publicReadiness(request = fetch) {
  const routes = [['/health',200,'ok'],['/ready',200,'ready'],['/me/capabilities',401]];
  const results = await Promise.all(routes.map(async ([path,status,bodyStatus]) => {
    const response = await request(endpoint + path, {
      headers: {Origin:origin,'Cache-Control':'no-cache'}, redirect:'error', signal: AbortSignal.timeout(12000)
    });
    check(response.status === status && response.headers.get('access-control-allow-origin') === origin,
      'PUBLIC_READINESS_OR_CORS');
    if (bodyStatus) check((await response.json()).status === bodyStatus,'PUBLIC_READINESS_BODY');
    else await response.body?.cancel();
    return [path, status];
  }));
  return Object.fromEntries(results);
}

function checkRuntime(observation, kind) {
  const mains = observation?.taskDefinition?.containerDefinitions?.filter(c => env(c).PACKPROOF_PROCESS_ROLE === kind);
  check(mains?.length === 1, 'SERVICE_PRIMARY');
  const e = env(mains[0]), image = mains[0].image, source = e.PACKPROOF_RELEASE_SHA;
  check(typeof image === 'string' && image.startsWith(TARGET.repository+'@sha256:') &&
    /^[a-f0-9]{64}$/.test(image.slice(TARGET.repository.length+8)) && /^[a-f0-9]{40}$/.test(source), 'SERVICE_IDENTITY');
  verifyService(observation,kind,{source,image},false);
  if (kind === 'api') {
    const primary = env(observation.express.activeConfigurations[0].primaryContainer);
    check(primary.PACKPROOF_RELEASE_SHA === source && primary.PACKPROOF_RELEASE_IMAGE === image &&
      primary.PACKPROOF_RELEASE_VERSION === e.PACKPROOF_RELEASE_VERSION &&
      typeof observation.meta.version === 'string' && observation.meta.version === e.PACKPROOF_RELEASE_VERSION,
    'PUBLIC_VERSION_OR_SOURCE');
  }
}

export async function observeRuntime({apiOnly=false, services=observeServices, discovery=readDiscovery,
  readiness=publicReadiness, clock=Date.now}={}) {
  const started = clock(), observedAt = new Date(started).toISOString();
  const [live,network,publicChecks] = await Promise.all([
    services({apiOnly}), apiOnly ? undefined : discovery(), apiOnly ? undefined : readiness()
  ]);
  checkRuntime(live.api,'api');
  const apiObservation = {...live.api,observedAt};
  if (apiOnly) return {apiObservation};
  checkRuntime(live.worker,'worker');
  check(clock()-started < 15*60_000, 'READ_EXPIRED');
  const topology=runtimeTopology(network,live.api), probe=probeNetwork(live.worker.service);
  Object.assign(apiObservation,{topology,publicChecks});
  const workerObservation={...live.worker,observedAt};
  return {snapshot:{
    account:TARGET.account,region:TARGET.region,observedAt,topology,probe,api:apiObservation,worker:workerObservation
  },apiObservation,workerObservation};
}

export async function saveObservation(dir, observations) {
  await mkdir(dir,{mode:0o700});
  try {
    for (const [name,data] of Object.entries({
      'snapshot.json':observations.snapshot, 'api-observation.json':observations.apiObservation,
      'worker-observation.json':observations.workerObservation
    })) {
      if (data) await writeFile(join(dir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
    }
  } catch(error) {
    await rm(dir,{recursive:true,force:true});
    throw error;
  }
}

async function main() {
  const [dir,option] = process.argv.slice(2);
  check(dir && !dir.startsWith('-') && process.argv.length <= 4 && (!option || option === '--api-only'),
    'EXPECTED_NEW_PRIVATE_DIR_OR_API_ONLY');
  const observations = await observeRuntime({apiOnly:option === '--api-only'});
  await saveObservation(dir,observations);
  console.log(JSON.stringify({readOnly:true,observedAt:observations.apiObservation.observedAt,
    privateFilesWritten:observations.snapshot ? 3 : 1}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error(/^(HOSTED_OBSERVE|OWNER_TASK)_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'HOSTED_OBSERVE_READ_OR_OUTPUT_FAILED');
  process.exitCode=1;
});
