// Offline requests for the129 -> compatible fallback ->130 -> Recovery runtime.
// No AWS operation, schema change, privilege change or feature activation occurs here.
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {TARGET,hash,makePlan,makeCollectorBridgeReplacement} from './backend-deployment-plan.mjs';
import {serviceWithRevision} from '../backend-service-state.mjs';
import {verifyService} from './connect-hosted-owner-task.mjs';
import {prepareRecoveryImages} from './recovery-image-builds.mjs';
import {inspectHostedLockEvidence} from './hosted-membership-locks.mjs';
import {preservationSnapshot} from './backend-release-requests.mjs';
import {recoveryTarget as target,recoveryLedgers,recoveryImage,recoveryBindingDigest,recoveryDigest} from './recovery-runtime-preflight.mjs';

const check=(ok,reason)=>{if(!ok)throw Error('CONNECT_RECOVERY_RUNTIME_'+reason);};
const releaseNames=['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'];
const kinds=['api','worker'],sides=['target','peer'];
const fresh=(at,now,age=900000)=>Number.isFinite(Date.parse(at)) && Date.parse(at)<=now && now-Date.parse(at)<=age;
const env=c=>Object.fromEntries((c.environment??[]).map(({name,value})=>[name,value]));
const taskFields=['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','pidMode','ipcMode','ephemeralStorage','runtimePlatform','enableFaultInjection'];
const responseFields=['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'];
const taskArn=v=>new RegExp(`^arn:aws:ecs:${target.region}:${target.account}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$`).test(v??'');
const executionArn=v=>new RegExp(`^arn:aws:ecs:${target.region}:${target.account}:task/${TARGET.cluster}/[a-f0-9]{32}$`).test(v??'');
const primary=(td,kind)=>{const list=td.containerDefinitions.filter(c=>env(c).PACKPROOF_PROCESS_ROLE===kind);
  check(list.length===1,'PRIMARY_CONTAINER');return list[0];};

export function normalizeRecoverySnapshot(input) {
  const s=structuredClone(input),a=s.api,configs=a?.express?.activeConfigurations;
  check(configs?.length===1 && a.revision?.serviceRevisionArn===configs[0].serviceRevisionArn &&
    a.nativeDeployment?.targetServiceRevision?.arn===a.revision.serviceRevisionArn,'CANARY_REVISION');
  a.service=serviceWithRevision(a.service,a.revision);
  check(a.nativeDeployment.status===a.nativeDeploymentStatus,'CANARY_STATUS');
  return s;
}

function cloneTask(td) {
  check(taskArn(td?.taskDefinitionArn) && td.status==='ACTIVE' && td.networkMode==='awsvpc' &&
    td.requiresCompatibilities?.includes('FARGATE') && td.containerDefinitions?.length>=1 && td.containerDefinitions.length<=2 &&
    Object.keys(td).every(k=>taskFields.includes(k)||responseFields.includes(k)),'TASK_SHAPE');
  check([td.taskRoleArn,td.executionRoleArn].every(a=>typeof a==='string'&&a.startsWith(`arn:aws:iam::${target.account}:role/`)),'TASK_ROLE');
  check((td.volumes??[]).every(v=>Object.keys(v).every(k=>k==='name'||k==='host'&&v.host&&typeof v.host==='object'&&!Array.isArray(v.host)&&Object.keys(v.host).length===0)),'PERSISTENT_VOLUME');
  for(const c of td.containerDefinitions) {
    const names=[...(c.environment??[]),...(c.secrets??[])].map(x=>x.name);
    check(names.length===new Set(names).size && !c.environmentFiles?.length && !c.credentialSpecs?.length,'AMBIGUOUS_BINDING');
  }
  return Object.fromEntries(taskFields.filter(k=>k in td).map(k=>[k,structuredClone(td[k])]));
}
function normalizedDefinition(definition) {
  const c=structuredClone(definition);
  for(const k of responseFields)delete c[k];
  for(const k of ['volumes','placementConstraints','inferenceAccelerators'])if(Array.isArray(c[k])&&!c[k].length)delete c[k];
  if(c.enableFaultInjection===false)delete c.enableFaultInjection;
  for(const item of c.containerDefinitions??[]) {
    if(item.cpu===0)delete item.cpu;
    for(const k of ['portMappings','mountPoints','volumesFrom','systemControls','environmentFiles','resourceRequirements','dependsOn','ulimits'])
      if(Array.isArray(item[k])&&!item[k].length)delete item[k];
    if(Array.isArray(item.logConfiguration?.secretOptions)&&!item.logConfiguration.secretOptions.length)delete item.logConfiguration.secretOptions;
    if(item.environment)item.environment.sort((a,b)=>a.name.localeCompare(b.name));
    if(item.secrets)item.secrets.sort((a,b)=>a.name.localeCompare(b.name));
  }
  return c;
}
const sameDefinition=(a,b)=>hash(normalizedDefinition(a))===hash(normalizedDefinition(b));
function fixedWorker(observation) {
  const task=cloneTask(observation.taskDefinition);
  for(const c of task.containerDefinitions){delete c.image;c.environment=(c.environment??[]).filter(x=>!releaseNames.includes(x.name));}
  return {task:normalizedDefinition(task),service:Object.fromEntries(['serviceArn','clusterArn','desiredCount','deploymentConfiguration','networkConfiguration','capacityProviderStrategy','launchType','platformVersion','healthCheckGracePeriodSeconds','loadBalancers','enableExecuteCommand'].filter(k=>k in observation.service).map(k=>[k,observation.service[k]]))};
}
export function recoveryConfigurationLease(s) {
  return hash({api:s.api.express.activeConfigurations,apiTask:s.api.taskDefinition,worker:fixedWorker(s.worker),probe:s.probe,topology:s.topology});
}
// Release-independent settings remain identical through both image cutovers.
// This pin is produced by the read-only inspection and reviewed before release.
export function recoveryPreservationHash(s) {
  return hash({api:preservationSnapshot(s.api),worker:fixedWorker(s.worker),probe:s.probe,topology:s.topology});
}
function validateSnapshot(s,now) {
  check(s.account===target.account && s.region===target.region && fresh(s.observedAt,now),'OBSERVATION_EXPIRED');
  check(s.topology?.trustedProxies?.configured===true && typeof s.topology.trustedProxies.value==='string' &&
    s.topology.trustedProxies.value.trim() && ['loadBalancers','targetGroups','securityGroups','subnets'].every(k=>Array.isArray(s.topology[k])&&s.topology[k].length),'TOPOLOGY');
  const p=s.probe,n=p?.networkConfiguration?.awsvpcConfiguration;
  check(p?.clusterArn===target.clusterArn && n && ['ENABLED','DISABLED'].includes(n.assignPublicIp) &&
    n.subnets?.length && n.subnets.every(x=>/^subnet-[a-f0-9]+$/.test(x)) && n.securityGroups?.length &&
    n.securityGroups.every(x=>/^sg-[a-f0-9]+$/.test(x)),'PROBE_NETWORK');
  check(!p.capacityProviderStrategy?.length || p.capacityProviderStrategy.every(x=>['FARGATE','FARGATE_SPOT'].includes(x.capacityProvider)),'PROBE_CAPACITY');
  for(const kind of kinds) {
    cloneTask(s[kind].taskDefinition);
    const e=env(primary(s[kind].taskDefinition,kind)),expected={source:e.PACKPROOF_RELEASE_SHA,image:e.PACKPROOF_RELEASE_IMAGE};
    check(/^[a-f0-9]{40}$/.test(expected.source??'') && recoveryImage(expected.image),'SERVICE_IDENTITY');
    verifyService(s[kind],kind,expected,false);
    check(!e.PACKPROOF_GUIDED_FACILITIES && !e.PACKPROOF_SETUP_AI_FACILITIES,'FACILITY_ACTIVATION_SEPARATE');
    check(!(s[kind].taskDefinition.containerDefinitions.flatMap(c=>c.secrets??[])).some(x=>['PACKPROOF_GUIDED_FACILITIES','PACKPROOF_SETUP_AI_FACILITIES'].includes(x.name)),'OPAQUE_FACILITY_FLAGS');
    if(kind==='api') {
      const c=s.api.express.activeConfigurations[0].primaryContainer,v=env(c);
      const refs=value=>Object.fromEntries((value.secrets??[]).map(x=>[x.name,x.valueFrom]));
      check(hash(v)===hash(e) && hash(refs(c))===hash(refs(primary(s.api.taskDefinition,'api'))),'EXPRESS_TASK_CONFIGURATION');
      check(v.PACKPROOF_RELEASE_SHA===expected.source && v.PACKPROOF_RELEASE_IMAGE===expected.image &&
        v.PACKPROOF_RELEASE_VERSION===e.PACKPROOF_RELEASE_VERSION && s.api.meta.version===e.PACKPROOF_RELEASE_VERSION &&
        !v.PACKPROOF_GUIDED_FACILITIES && !v.PACKPROOF_SETUP_AI_FACILITIES,'PUBLIC_CONFIGURATION');
      check(s.api.publicChecks?.['/health']===200 && s.api.publicChecks?.['/ready']===200 &&
        s.api.publicChecks?.['/me/capabilities']===401,'PUBLIC_READINESS');
    }
  }
}
function registeredImage(response,tag) {
  const list=response?.imageDetails;
  check(list?.length===1 && list[0].registryId===target.account && list[0].repositoryName===TARGET.serviceName &&
    list[0].imageTags?.includes(tag) && /^sha256:[a-f0-9]{64}$/.test(list[0].imageDigest),'ECR_IMAGE');
  return target.repository+'@'+list[0].imageDigest;
}
export function recoveryBuildPublication(build,log,images) {
  check(log?.group===build.logs?.groupName && log?.stream===build.logs?.streamName && Array.isArray(log.events),'BUILD_LOG_BINDING');
  const text=log.events.map(e=>e.message).join('\n'),records=[];
  // AWS CLI formats DescribeImages over several log events. Parse complete JSON
  // objects beginning on a line; never extract arbitrary hashes from log text.
  for(const match of text.matchAll(/^\s*\{/gm)) {
    const start=text.indexOf('{',match.index);let depth=0,quoted=false,escaped=false;
    for(let i=start;i<text.length;i++) {
      const ch=text[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
      if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0) {
        try{records.push(JSON.parse(text.slice(start,i+1)));}catch{}
        break;
      }
    }
  }
  const receipts=records.filter(r=>r.schema==='packproof.recovery-images/v1');
  check(receipts.length===1 && hash(receipts[0])===hash(images),'BUILD_LOG_RECEIPT');
  const publications=records.filter(r=>Array.isArray(r.imageDetails)&&r.imageDetails.length===2&&
    [images.candidateTag,images.fallbackTag].every(tag=>r.imageDetails.some(d=>d.imageTags?.includes(tag))));
  check(publications.length===1,'ONE_BUILD_PUBLICATION');
  return Object.fromEntries([['candidate',images.candidateTag],['fallback',images.fallbackTag]].map(([name,tag])=>
    [name,registeredImage({imageDetails:publications[0].imageDetails.filter(d=>d.imageTags?.includes(tag))},tag)]));
}
export function verifyRecoveryRelease(release) {
  const images=release?.images,source=images?.source,ci=release?.ci;
  check(images?.schema==='packproof.recovery-images/v1' && /^[a-f0-9]{40}$/.test(source??'') &&
    images.inventorySha256===recoveryLedgers[130].sha256 && images.previousInventorySha256===recoveryLedgers[129].sha256 &&
    images.candidateTag==='recovery-v1-'+source && images.fallbackTag==='recovery-compat-'+source && recoveryImage(images.predecessorImage),'BUILD_RECEIPT');
  check(ci?.repository?.full_name==='thepackproof/packproof-v2' && ci.name==='CI' && ci.path==='.github/workflows/ci.yml' &&
    ci.head_sha===source && ci.head_branch==='main' && ['push','workflow_dispatch'].includes(ci.event) &&
    ci.status==='completed' && ci.conclusion==='success','SOURCE_CI');
  const {archiveSha256,sourceVersion}=release;
  const expected=prepareRecoveryImages({source,archiveSha256,sourceVersion,predecessorImage:images.predecessorImage}).request;
  const build=release.build?.builds?.[0]??release.build;
  check(build?.projectName===TARGET.serviceName && build.buildStatus==='SUCCEEDED' && build.buildComplete===true &&
    build.source?.type==='S3' && build.source.location===expected.sourceLocationOverride &&
    build.sourceVersion===sourceVersion && build.source.buildspec===expected.buildspecOverride &&
    typeof build.id==='string' && build.id.startsWith(TARGET.serviceName+':'),'SUCCESSFUL_IMAGE_BUILD');
  for(const wanted of expected.environmentVariablesOverride) {
    const found=build.environment?.environmentVariables?.filter(v=>v.name===wanted.name);
    check(found?.length===1 && found[0].type===wanted.type && found[0].value===wanted.value,'BUILD_PIN');
  }
  const result={source,archiveSha256,sourceVersion,buildId:build.id,ciRunId:ci.id,
    candidate:registeredImage(release.candidate,images.candidateTag),fallback:registeredImage(release.fallback,images.fallbackTag),
    predecessor:images.predecessorImage};
  const publication=recoveryBuildPublication(build,release.buildLog,images);
  check(result.candidate===publication.candidate && result.fallback===publication.fallback,'ECR_PUBLICATION_CHANGED');
  check(new Set([result.candidate,result.fallback,result.predecessor]).size===3,'DISTINCT_IMAGES');
  return result;
}

export function createRecoveryRuntimeReview({snapshot,release,profile,expiresAt,version='setup-recovery-0.7.1'},now=Date.now()) {
  check(['fallback','candidate','recovery'].includes(profile),'PROFILE');
  const s=normalizeRecoverySnapshot(snapshot);validateSnapshot(s,now);
  const evidence=verifyRecoveryRelease(release),through=profile==='fallback'?129:130;
  const expected={};
  for(const kind of kinds) {
    const o=s[kind],e=env(primary(o.taskDefinition,kind));
    expected[kind]={source:e.PACKPROOF_RELEASE_SHA,image:e.PACKPROOF_RELEASE_IMAGE,taskDefinition:o.taskDefinition.taskDefinitionArn};
    const allowed=profile==='fallback'?[evidence.predecessor]:profile==='candidate'?[evidence.fallback]:[evidence.candidate,evidence.fallback];
    check(allowed.includes(expected[kind].image) && (profile==='fallback'||expected[kind].source===evidence.source),'PREDECESSOR');
  }
  check(profile!=='fallback'||expected.api.source===expected.worker.source,'PREDECESSOR_SOURCE');
  check(profile!=='recovery'||kinds.some(k=>expected[k].image===evidence.candidate),'RECOVERY_ALREADY_COMPLETE');
  check(/^[A-Za-z0-9._-]{1,100}$/.test(version),'VERSION');
  const review={schema:'packproof.recovery-runtime-review/v1',profile,source:evidence.source,evidence,expected,
    targetImage:profile==='candidate'?evidence.candidate:evidence.fallback,
    peerImage:profile==='fallback'?evidence.predecessor:profile==='candidate'?evidence.fallback:evidence.candidate,
    peerSource:profile==='fallback'?expected.api.source:evidence.source,ledgerThrough:through,
    version,expiresAt,configurationLeaseSha256:recoveryConfigurationLease(s),topologySha256:hash(s.topology),
    probeNetworkSha256:hash(s.probe),probeCodeSha256:recoveryDigest(probeSource()),
    featureActivation:false,permittedChanges:['image',...releaseNames]};
  validateReview(s,review,now);return review;
}
function probeSource(){return readFileSync(new URL('./recovery-runtime-preflight.mjs',import.meta.url),'utf8');}
function validateReview(s,r,now) {
  validateSnapshot(s,now);
  check(r?.schema==='packproof.recovery-runtime-review/v1' && ['fallback','candidate','recovery'].includes(r.profile) &&
    recoveryImage(r.targetImage) && recoveryImage(r.peerImage) && r.targetImage!==r.peerImage &&
    r.source===r.evidence?.source && r.targetImage===(r.profile==='candidate'?r.evidence.candidate:r.evidence.fallback) &&
    r.peerImage===(r.profile==='fallback'?r.evidence.predecessor:r.profile==='candidate'?r.evidence.fallback:r.evidence.candidate) &&
    r.ledgerThrough===(r.profile==='fallback'?129:130) && r.featureActivation===false,'REVIEW');
  check(Date.parse(r.expiresAt)>now && Date.parse(r.expiresAt)-now<=7200000,'REVIEW_EXPIRED');
  check(r.configurationLeaseSha256===recoveryConfigurationLease(s) && r.topologySha256===hash(s.topology) &&
    r.probeNetworkSha256===hash(s.probe) && r.probeCodeSha256===recoveryDigest(probeSource()),'CONFIGURATION_CHANGED');
  for(const k of kinds) {
    const c=primary(s[k].taskDefinition,k),e=env(c),p=r.expected[k];
    check(p.image===c.image && p.image===e.PACKPROOF_RELEASE_IMAGE && p.source===e.PACKPROOF_RELEASE_SHA &&
      p.taskDefinition===s[k].taskDefinition.taskDefinitionArn,'PREDECESSOR_CHANGED');
  }
}

export function recoveryProbeReview(s,r,side,kind) {
  check(sides.includes(side)&&kinds.includes(kind),'PROBE_KIND');
  const c=primary(s[kind].taskDefinition,kind),e=env(c),names=Object.keys(e).filter(k=>!releaseNames.includes(k)).sort();
  const image=side==='target'?r.targetImage:r.peerImage;
  const sourceThrough=image===r.evidence.candidate?130:129;
  return {schema:'packproof.recovery-runtime-probe-review/v1',releaseReviewSha256:hash(r),profile:r.profile,side,kind,
    source:side==='peer'?r.peerSource:r.source,image,sourceThrough,ledgerThrough:r.ledgerThrough,
    fullPrivileges:sourceThrough===r.ledgerThrough,clusterArn:target.clusterArn,target:{host:target.host,database:target.database},
    apiRole:target.apiRole,workerRole:target.workerRole,ownerRole:target.ownerRole,expiresAt:r.expiresAt,
    environmentNames:names,environmentSha256:recoveryBindingDigest(Object.fromEntries(names.map(k=>[k,e[k]])))};
}
function setRelease(c,{source,image,version}) {
  const values=env(c);
  check(releaseNames.every(k=>Object.hasOwn(values,k)) && values.PACKPROOF_MIGRATE_ON_START==='false','RELEASE_BINDINGS');
  const next={PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_VERSION:version};
  c.image=image;c.environment=c.environment.map(x=>releaseNames.includes(x.name)?{...x,value:next[x.name]}:x);
}
export function recoveryProbeRegistrations(snapshot,review,now=Date.now()) {
  const s=normalizeRecoverySnapshot(snapshot),r=review;validateReview(s,r,now);
  const result={},code=gzipSync(probeSource()).toString('base64');
  for(const side of sides)for(const kind of kinds) {
    const probe=recoveryProbeReview(s,r,side,kind),td=cloneTask(s[kind].taskDefinition);
    td.family='packproof-recovery-probe-'+r.source.slice(0,12)+'-'+side+'-'+kind;
    for(const c of td.containerDefinitions) {
      c.image=probe.image;
      if(c===primary(td,kind)||releaseNames.some(k=>Object.hasOwn(env(c),k)))setRelease(c,{...probe,version:r.version});
    }
    const c=primary(td,kind);
    check(c.logConfiguration?.logDriver==='awslogs' && c.logConfiguration.options?.['awslogs-region']===target.region &&
      c.logConfiguration.options['awslogs-group'] && c.logConfiguration.options['awslogs-stream-prefix'],'PROBE_LOGS');
    c.entryPoint=[];c.portMappings=[];delete c.healthCheck;delete c.restartPolicy;
    const encodedReview=gzipSync(JSON.stringify(probe)).toString('base64');
    check(![...(c.environment??[]),...(c.secrets??[])].some(x=>['PACKPROOF_CONNECT_RECOVERY_PROBE_REVIEW','PACKPROOF_CONNECT_RECOVERY_PROBE_CODE'].includes(x.name)),'PROBE_BINDING_EXISTS');
    check(Buffer.byteLength(code)<16384,'PROBE_PROGRAM_TOO_LARGE');
    c.environment.push({name:'PACKPROOF_CONNECT_RECOVERY_PROBE_REVIEW',value:encodedReview},{name:'PACKPROOF_CONNECT_RECOVERY_PROBE_CODE',value:code});
    c.command=['node','--input-type=module','-e',`import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const source=gunzipSync(Buffer.from(process.env.PACKPROOF_CONNECT_RECOVERY_PROBE_CODE,'base64'));
const review=JSON.parse(gunzipSync(Buffer.from(process.env.PACKPROOF_CONNECT_RECOVERY_PROBE_REVIEW,'base64')));
const timer=setTimeout(()=>process.exit(2),180000);timer.unref();let module;
try{if(createHash('sha256').update(source).digest('hex')!=='${r.probeCodeSha256}')throw Error('PROBE_CODE_BINDING');
module=await import('data:text/javascript;base64,'+source.toString('base64'));await module.executeRecoveryProbe(review);}
catch(e){console.error(JSON.stringify(module?.formatRecoveryProbeFailure(e)??{event:'recovery_runtime_probe_failed',stage:'LOAD_PROBE',code:'OPERATION_FAILED'}));process.exitCode=1;}
finally{clearTimeout(timer);}`];
    // Bound the embedded program independently of ECS's separate RunTask
    // overrides limit. RunTask never overrides a registered probe command.
    check(Buffer.byteLength(JSON.stringify(c.command))<8192,'PROBE_PROGRAM_TOO_LARGE');
    result[side+'-'+kind]=td;
  }
  return result;
}
function verifyRegistered(actual,expected) {
  const d=actual?.taskDefinition??actual;
  check(d?.status==='ACTIVE' && taskArn(d.taskDefinitionArn) && d.family===expected.family &&
    d.taskDefinitionArn.startsWith(`arn:aws:ecs:${target.region}:${target.account}:task-definition/${expected.family}:`) &&
    sameDefinition(d,expected),'REGISTERED_DEFINITION');
  return d;
}
// Shared by the fixed read-only facility inspector; provider defaults are
// normalized identically, without accepting a caller-selected executable.
export {verifyRegistered as verifyRecoveryTaskRegistration};
export function recoveryProbeRunRequest({snapshot,review,label,registered,retryOf},now=Date.now()) {
  const s=normalizeRecoverySnapshot(snapshot),definitions=recoveryProbeRegistrations(s,review,now);
  check(Object.hasOwn(definitions,label),'PROBE_LABEL');
  const td=verifyRegistered(registered,definitions[label]);
  if(retryOf)check(executionArn(retryOf.taskArn) && retryOf.clusterArn===target.clusterArn && retryOf.taskDefinitionArn===td.taskDefinitionArn &&
    retryOf.lastStatus==='STOPPED' && (retryOf.stopCode==='TaskFailedToStart'||retryOf.containers?.some(c=>Number.isInteger(c.exitCode)&&c.exitCode!==0)),'FAILED_RETRY_REQUIRED');
  return {cluster:target.clusterArn,count:1,taskDefinition:td.taskDefinitionArn,enableExecuteCommand:false,
    networkConfiguration:structuredClone(s.probe.networkConfiguration),platformVersion:s.probe.platformVersion??'1.4.0',
    ...(s.probe.capacityProviderStrategy?.length?{capacityProviderStrategy:structuredClone(s.probe.capacityProviderStrategy)}:{launchType:'FARGATE'}),
    clientToken:hash({review,label,td:td.taskDefinitionArn,retry:retryOf?.taskArn??null}),startedBy:'recovery-'+review.source.slice(0,12)+'-'+label};
}
function noOverrides(task) {
  const o=task.overrides??{};
  return Object.keys(o).every(k=>k==='containerOverrides'||k==='inferenceAcceleratorOverrides'&&Array.isArray(o[k])&&!o[k].length) &&
    (o.containerOverrides??[]).every(c=>Object.keys(c).length===1&&typeof c.name==='string');
}
export function collectRecoveryProbeReceipt({taskDefinition,task,logGroup,logStream,events}) {
  check(executionArn(task?.taskArn) && task.clusterArn===target.clusterArn && task.lastStatus==='STOPPED' &&
    task.taskDefinitionArn===taskDefinition?.taskDefinitionArn && noOverrides(task),'STOPPED_TASK');
  const match=/^packproof-recovery-probe-[a-f0-9]{12}-(target|peer)-(api|worker)$/.exec(taskDefinition.family??'');
  check(match,'PROBE_FAMILY');
  const c=primary(taskDefinition,match[2]),o=c.logConfiguration?.options;
  check(logGroup===o?.['awslogs-group'] && logStream===o?.['awslogs-stream-prefix']+'/'+c.name+'/'+task.taskArn.split('/').at(-1),'LOG_STREAM');
  const reports=(events??[]).flatMap(event=>{try{return[JSON.parse(event.message)];}catch{return[];}})
    .filter(r=>r.schema==='packproof.recovery-runtime-probe/v1');
  check(reports.length===1 && reports[0].taskIdentity?.taskArn===task.taskArn,'ONE_REPORT');
  return {registered:taskDefinition,task,report:reports[0],log:{group:logGroup,stream:logStream}};
}

function qualifyProbe(q,definition,probe,now) {
  const td=verifyRegistered(q?.registered,definition),task=q.task,report=q.report;
  check(executionArn(task?.taskArn) && task.clusterArn===target.clusterArn && task.taskDefinitionArn===td.taskDefinitionArn &&
    task.lastStatus==='STOPPED' && noOverrides(task) && task.containers?.length===td.containerDefinitions.length &&
    new Set(task.containers.map(c=>c.name)).size===task.containers.length && task.containers.every(c=>td.containerDefinitions.some(x=>x.name===c.name)&&
      c.exitCode===0 && c.lastStatus==='STOPPED' && c.imageDigest===probe.image.split('@')[1]),'PROBE_TASK_RESULT');
  const options=primary(td,probe.kind).logConfiguration.options;
  check(q.log?.group===options['awslogs-group'] && q.log.stream===options['awslogs-stream-prefix']+'/'+primary(td,probe.kind).name+'/'+task.taskArn.split('/').at(-1),'PROBE_LOG_BINDING');
  check(report?.schema==='packproof.recovery-runtime-probe/v1' && report.reviewSha256===recoveryBindingDigest(probe) &&
    report.source===probe.source && report.kind===probe.kind && report.side===probe.side && report.profile===probe.profile &&
    report.taskIdentity?.taskArn===task.taskArn && report.taskIdentity.image===probe.image &&
    report.taskIdentity.imageDigest===probe.image.split('@')[1] && fresh(report.completedAt,now) &&
    report.ledgerThrough===probe.ledgerThrough && report.sourceThrough===probe.sourceThrough &&
    report.fullPrivileges===probe.fullPrivileges && report.environmentSha256===probe.environmentSha256 &&
    report.readOnly===true && report.featureActivation===false,'PROBE_REPORT');
  const role=probe.kind==='api'?target.apiRole:target.workerRole;
  check(report.identity?.role===role && report.identity.login===role && report.identity.database===target.database &&
    report.identity.schema==='public' && report.identity.read_only==='on' && report.tls?.ssl===true &&
    ['schemaReaderVerified','immutableTriggerVerified','backfillScopeVerified','orderHistoryGuardsVerified','legacyReaderVerified',
      'durabilityPolicyMatches','compiledCollectorVerified'].every(k=>report[k]===true),'PROBE_AUTHORITY');
  check(report.legacyReaderKind===(probe.kind==='api'?'order-history':'worker-imports') &&
    report.workerOrderHistoryDenied===(probe.kind==='worker'?true:null),'ROLE_READER');
  inspectHostedLockEvidence(report.platformLocks,role);
  check(/^[a-f0-9]{64}$/.test(report.m2PrivilegesSha256??'') && report.inventory?.sourceCount===recoveryLedgers[probe.sourceThrough].count &&
    report.inventory.appliedCount===recoveryLedgers[probe.ledgerThrough].count &&
    report.inventory.sourceSha256===recoveryLedgers[probe.sourceThrough].sha256 &&
    report.inventory.inventorySha256===recoveryLedgers[probe.ledgerThrough].sha256 &&
    report.inventory.migrationsApplied===false && report.inventory.rolesChanged===false,'PROBE_LEDGER');
  if(probe.fullPrivileges) {
    const p=report.recordsPrivileges;
    check(p?.schema==='packproof.records-runtime-privileges/v1' && p.sourceCommit===probe.source && p.databaseSchema==='public' &&
      p.caller===role && p.runtimeRole===target.apiRole && p.workerRole===target.workerRole &&
      ['migrationSha256','policySha256','effectivePrivilegesSha256'].every(k=>/^[a-f0-9]{64}$/.test(p[k]??'')),'PROBE_PRIVILEGES');
  } else check(report.recordsPrivileges===null,'READER_ONLY_REPORT');
  const a=report.automationPolicy;
  check(a?.schema==='packproof.shipment-policy-role/v1' && a.kind===probe.kind && /^[a-f0-9]{64}$/.test(a.bundleSha256??'') &&
    a.interpretationVersion==='packproof.shipment-interpretation/v1' && a.headerPolicyVersion==='same_names_any_order/v1','AUTOMATION_POLICY');
  if(probe.profile==='recovery')check(report.recoveryQuiescence &&
    ['active_sources','pending_batches','pending_projections'].every(k=>report.recoveryQuiescence[k]===0),'RECOVERY_WORK_REMAINS');
  else check(report.recoveryQuiescence===null,'UNEXPECTED_RECOVERY_REPORT');
  return report;
}
function comparePair(reports,r) {
  for(const side of sides) {
    const api=reports[side+'-api'],worker=reports[side+'-worker'];
    check(api.automationPolicy.bundleSha256===worker.automationPolicy.bundleSha256,'ROLE_BUILD_POLICY');
    if(api.fullPrivileges)check(worker.fullPrivileges && ['migrationSha256','policySha256','effectivePrivilegesSha256'].every(k=>
      api.recordsPrivileges[k]===worker.recordsPrivileges[k]),'ROLE_PRIVILEGES');
  }
  check(kinds.every(kind=>sides.some(side=>reports[side+'-'+kind].fullPrivileges)),'FULL_ROLE_QUALIFICATION');
  if(r.profile==='fallback')check(reports['target-api'].automationPolicy.bundleSha256===reports['peer-api'].automationPolicy.bundleSha256,'FALLBACK_APPLICATION_CHANGED');
  for(const kind of kinds) {
    const a={...reports['target-'+kind].automationPolicy},b={...reports['peer-'+kind].automationPolicy};
    delete a.bundleSha256;delete b.bundleSha256;
    check(hash(a)===hash(b),'EXISTING_AUTOMATION_CHANGED');
  }
}
function changedWorker(s,r) {
  const td=cloneTask(s.worker.taskDefinition);
  for(const c of td.containerDefinitions){c.image=r.targetImage;
    if(c===primary(td,'worker')||releaseNames.some(k=>Object.hasOwn(env(c),k)))setRelease(c,{source:r.source,image:r.targetImage,version:r.version});}
  check(hash(fixedWorker({service:s.worker.service,taskDefinition:{...td,status:'ACTIVE',taskDefinitionArn:s.worker.taskDefinition.taskDefinitionArn}}))===hash(fixedWorker(s.worker)),'WORKER_PRESERVATION');
  return td;
}
export function createRecoveryRuntimePlan({snapshot,review,probes},now=Date.now()) {
  const s=normalizeRecoverySnapshot(snapshot),r=review,definitions=recoveryProbeRegistrations(s,r,now),reports={};
  for(const side of sides)for(const kind of kinds){const label=side+'-'+kind;
    reports[label]=qualifyProbe(probes?.[label],definitions[label],recoveryProbeReview(s,r,side,kind),now);}
  check(new Set(Object.values(reports).map(x=>x.taskIdentity.taskArn)).size===4,'DISTINCT_PROBE_TASKS');comparePair(reports,r);
  const candidate={sourceSha:r.source,image:r.targetImage,version:r.version,expectedPreviousImage:r.expected.api.image,
    expectedPreviousTaskDefinition:r.expected.api.taskDefinition,ciPassed:true,databasePreflightPassed:true,sourceArchiveVerified:true};
  let api;
  if(r.targetImage===r.expected.api.image)api={update:null,rollback:{serviceArn:TARGET.serviceArn,primaryContainer:structuredClone(s.api.express.activeConfigurations[0].primaryContainer)}};
  else api=r.source===r.expected.api.source?makeCollectorBridgeReplacement({...s.api,account:s.account,region:s.region},candidate,r.expected.api.image)
    :makePlan({...s.api,account:s.account,region:s.region},candidate);
  const plan={schema:'packproof.recovery-runtime-plan/v1',review:r,preparedAt:new Date(now).toISOString(),expiresAt:r.expiresAt,
    source:r.source,image:r.targetImage,profile:r.profile,ledgerThrough:r.ledgerThrough,
    apiConfigurationSha256:hash(s.api.express.activeConfigurations),topologySha256:hash(s.topology),
    workerConfigurationSha256:hash(fixedWorker(s.worker)),workerPreviousTaskDefinition:s.worker.taskDefinition.taskDefinitionArn,
    workerPreviousImage:r.expected.worker.image,workerRegister:changedWorker(s,r),apiUpdate:api.update,
    rollbackApi:api.rollback,workerServiceArn:s.worker.service.serviceArn,workerClusterArn:s.worker.service.clusterArn,
    probeTasks:Object.values(reports).map(x=>x.taskIdentity.taskArn),probeReceiptsSha256:hash(reports),
    order:r.profile==='recovery'?['api','worker']:['worker','api'],featureActivation:false};
  return {...plan,planSha256:hash(plan)};
}
function validPlan(p,now) {
  const {planSha256,...body}=p??{};
  check(p?.schema==='packproof.recovery-runtime-plan/v1' && planSha256===hash(body) && fresh(p.preparedAt,now) &&
    Date.parse(p.expiresAt)>now && p.image===p.review?.targetImage && p.source===p.review?.source && p.featureActivation===false,'PLAN_EXPIRED_OR_CHANGED');
}
function workerUnchanged(plan,o,now) {
  check(fresh(o?.observedAt,now) && o.service?.taskDefinition===plan.workerPreviousTaskDefinition &&
    hash(fixedWorker(o))===plan.workerConfigurationSha256,'WORKER_DRIFT');
  verifyService(o,'worker',{source:plan.review.expected.worker.source,image:plan.review.expected.worker.image},false);
}
function apiUnchanged(plan,observation,now) {
  const api=normalizeRecoverySnapshot({api:observation}).api;
  check(fresh(api.observedAt,now) && hash(api.express.activeConfigurations)===plan.apiConfigurationSha256 &&
    hash(api.topology)===plan.topologySha256,'API_DRIFT');
  verifyService(api,'api',{source:plan.review.expected.api.source,image:plan.review.expected.api.image},false);
  return api;
}
export function recoveryWorkerRegistration(plan,now=Date.now()) {validPlan(plan,now);return structuredClone(plan.workerRegister);}
function promotedWorker(plan,o,now) {
  check(fresh(o?.observedAt,now) && sameDefinition(o.taskDefinition,plan.workerRegister) &&
    hash(fixedWorker(o))===plan.workerConfigurationSha256,'PROMOTED_WORKER_CONFIGURATION');
  verifyService(o,'worker',{source:plan.source,image:plan.image},false);
}
export function recoveryWorkerUpdate({plan,registered,observation},now=Date.now()) {
  validPlan(plan,now);check(plan.profile!=='recovery','RECOVERY_API_FIRST');workerUnchanged(plan,observation,now);
  const td=verifyRegistered(registered,plan.workerRegister);
  return {cluster:plan.workerClusterArn,service:plan.workerServiceArn,taskDefinition:td.taskDefinitionArn};
}
export function recoveryApiUpdate({plan,apiObservation,workerObservation},now=Date.now()) {
  validPlan(plan,now);check(plan.profile!=='recovery','RECOVERY_API_FIRST');apiUnchanged(plan,apiObservation,now);
  promotedWorker(plan,workerObservation,now);check(plan.apiUpdate,'API_ALREADY_TARGET');return structuredClone(plan.apiUpdate);
}
export function recoveryRecoveryApiUpdate({plan,apiObservation,workerObservation},now=Date.now()) {
  validPlan(plan,now);check(plan.profile==='recovery' && plan.ledgerThrough===130,'RECOVERY_PROFILE');
  apiUnchanged(plan,apiObservation,now);workerUnchanged(plan,workerObservation,now);
  check(plan.apiUpdate,'API_ALREADY_TARGET');return structuredClone(plan.apiUpdate);
}
export function recoveryRecoveryWorkerUpdate({plan,registered,apiObservation,workerObservation},now=Date.now()) {
  validPlan(plan,now);check(plan.profile==='recovery' && plan.ledgerThrough===130,'RECOVERY_PROFILE');
  const api=normalizeRecoverySnapshot({api:apiObservation}).api;
  check(plan.review.expected.api.image===plan.image,'RECOVERY_REFRESH_AFTER_API');
  check(fresh(api.observedAt,now) && hash(api.topology)===plan.topologySha256,'RECOVERY_API_OBSERVATION');
  verifyService(api,'api',{source:plan.source,image:plan.image},false);
  const wanted=plan.apiUpdate?.primaryContainer??plan.rollbackApi.primaryContainer;
  check(hash(api.express.activeConfigurations[0].primaryContainer)===hash(wanted),'RECOVERY_API_CONFIGURATION');
  workerUnchanged(plan,workerObservation,now);const td=verifyRegistered(registered,plan.workerRegister);
  return {cluster:plan.workerClusterArn,service:plan.workerServiceArn,taskDefinition:td.taskDefinitionArn};
}
