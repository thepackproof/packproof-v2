/** Offline request constructor only. No AWS calls or deployment execution. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({ account: '784514617543', region: 'us-east-1',
  cluster: 'packproof-v2-staging-cluster', serviceName: 'packproof-v2-staging-api',
  serviceArn: 'arn:aws:ecs:us-east-1:784514617543:service/packproof-v2-staging-cluster/packproof-v2-staging-api',
  repository: '784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api' });
const releaseNames = ['PACKPROOF_RELEASE_SHA', 'PACKPROOF_RELEASE_IMAGE', 'PACKPROOF_RELEASE_VERSION'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw new Error(message); };
function bindings(container) {
  const names = new Set();
  for (const [kind, field] of [['environment', 'value'], ['secrets', 'valueFrom']]) {
    if (!Array.isArray(container[kind] ?? [])) fail('INVALID_BINDINGS');
    for (const item of container[kind] ?? []) {
      if (!item || typeof item.name !== 'string' || !item.name || typeof item[field] !== 'string' || names.has(item.name)) fail('DUPLICATE_OR_INVALID_BINDING');
      names.add(item.name);
    }
  }
  return Object.fromEntries((container.environment ?? []).map(item => [item.name, item.value]));
}
export function makePlan(snapshot, candidate) {
  if (snapshot.account !== TARGET.account || snapshot.region !== TARGET.region || snapshot.service.serviceArn !== TARGET.serviceArn || snapshot.express.serviceArn !== TARGET.serviceArn) fail('TARGET_MISMATCH');
  if (snapshot.service.status !== 'ACTIVE' || snapshot.service.desiredCount < 1 || snapshot.service.runningCount !== snapshot.service.desiredCount || snapshot.service.pendingCount !== 0 || snapshot.nativeDeploymentStatus !== 'SUCCESSFUL') fail('PREDECESSOR_NOT_STABLE');
  if (snapshot.express.activeConfigurations?.length !== 1) fail('AMBIGUOUS_ACTIVE_CONFIGURATION');
  const config = snapshot.express.activeConfigurations[0];
  const original = config.primaryContainer;
  const env = bindings(original);
  if (env.PACKPROOF_MIGRATE_ON_START !== 'false') fail('AUTOMATIC_MIGRATION_NOT_DISABLED');
  if (env.PACKPROOF_ENVIRONMENT !== 'staging' || !env.PACKPROOF_WEB_ORIGINS || !env.PACKPROOF_PUBLIC_URL) fail('RUNTIME_CONTEXT_MISSING');
  if (releaseNames.some(name => !Object.hasOwn(env, name))) fail('RELEASE_BINDINGS_MISSING');
  if (snapshot.meta.commit !== env.PACKPROOF_RELEASE_SHA || snapshot.meta.image !== env.PACKPROOF_RELEASE_IMAGE || snapshot.meta.version !== env.PACKPROOF_RELEASE_VERSION || snapshot.meta.image !== original.image) fail('PUBLIC_CONTROL_PLANE_IDENTITY_MISMATCH');
  const imagePrefix = `${TARGET.repository}@sha256:`;
  const immutableImage = value => typeof value === 'string' && value.startsWith(imagePrefix) && /^[a-f0-9]{64}$/.test(value.slice(imagePrefix.length));
  if (!immutableImage(original.image) || !immutableImage(candidate.image)) fail('IMMUTABLE_IMAGE_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(candidate.sourceSha) || candidate.sourceSha === snapshot.meta.commit || !/^[A-Za-z0-9._-]{1,100}$/.test(candidate.version)) fail('INVALID_CANDIDATE_IDENTITY');
  if (candidate.expectedPreviousImage !== original.image || candidate.expectedPreviousTaskDefinition !== snapshot.service.taskDefinition) fail('PREDECESSOR_MISMATCH');
  if (candidate.ciPassed !== true || candidate.databasePreflightPassed !== true || candidate.sourceArchiveVerified !== true) fail('RELEASE_GATES_INCOMPLETE');
  const next = structuredClone(original);
  next.image = candidate.image;
  const changed = { PACKPROOF_RELEASE_SHA: candidate.sourceSha, PACKPROOF_RELEASE_IMAGE: candidate.image, PACKPROOF_RELEASE_VERSION: candidate.version };
  next.environment = next.environment.map(item => Object.hasOwn(changed, item.name) ? { ...item, value: changed[item.name] } : item);
  bindings(next);
  const preserved = container => ({ ...container, image: undefined, environment: container.environment.filter(item => !releaseNames.includes(item.name)) });
  if (hash(preserved(next)) !== hash(preserved(original))) fail('UNEXPECTED_CONTAINER_CHANGE');
  // Omitted top-level fields are not set to legacy defaults. Preserve CPU/memory,
  // scaling, roles, network, health and managed deployment policy in the service.
  return {
    summary: {
      draftOnly: true, sourceSha: candidate.sourceSha, candidateImage: candidate.image,
      previousSourceSha: snapshot.meta.commit, rollbackImage: original.image,
      previousTaskDefinition: snapshot.service.taskDefinition,
      snapshotSha256: hash(snapshot), configurationSha256: hash(config),
      preservedPrimaryContainerSha256: hash(preserved(original)),
      environmentNames: original.environment.map(item => item.name).sort(),
      secretNames: (original.secrets ?? []).map(item => item.name).sort(),
      desiredCount: snapshot.service.desiredCount,
      permittedChanges: ['primaryContainer.image', ...releaseNames.map(name => `primaryContainer.environment.${name}`)],
      warning: 'Full request files contain runtime configuration. Keep private; never publish or echo them.'
    },
    update: { serviceArn: TARGET.serviceArn, primaryContainer: next },
    rollback: { serviceArn: TARGET.serviceArn, primaryContainer: structuredClone(original) }
  };
}

async function main() {
  const [snapshotPath, candidatePath, outputPrefix] = process.argv.slice(2);
  if (!snapshotPath || !candidatePath || !outputPrefix || process.argv.length !== 5) throw Error('Usage: node backend-deployment-plan.mjs PRIVATE_SNAPSHOT.json CANDIDATE.json PRIVATE_OUTPUT_PREFIX');
  const plan = makePlan(JSON.parse(await readFile(snapshotPath, 'utf8')), JSON.parse(await readFile(candidatePath, 'utf8')));
  for (const name of ['summary', 'update', 'rollback']) await writeFile(`${outputPrefix}.${name}.json`, JSON.stringify(plan[name], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ draftOnly: true, requestFilesWritten: 3, awsOperationsPerformed: 0, sourceSha: plan.summary.sourceSha }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
