/** Source-bound, image-only release requests. No AWS calls, DDL, grants or feature activation. */
import {shipmentRelease,shipmentRuntimeInventory,shipmentReleaseInventory,verifyShipmentDeploymentReview,verifyShipmentProbeReports,configureShipmentProbe} from './shipment-deployment-review.mjs';
import {backfillMigrationInventorySha256} from './reconstruction-v8-release-review.mjs';
import {workspaceInventory,workspaceMigration} from './reconstruction-v10-release-review.mjs';
import {buildRequest} from './backend-release-requests.mjs';
import {makePlan,TARGET,hash} from './backend-deployment-plan.mjs';

export const CONNECT_RUNTIME_INVENTORY=Object.freeze({count:108,sha256:'a873b3f50dc1d4a380067d4a3d1a642472827df2fb2e99634ac3b45aa6260a6d'});
const fail=code=>{throw Error(code);},check=(ok,code)=>{if(!ok)fail(code);};
const sha=/^[a-f0-9]{40}$/,digest=/^[a-f0-9]{64}$/;
const releaseNames=['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'];
const image=value=>typeof value==='string'&&value.startsWith(TARGET.repository+'@sha256:')&&digest.test(value.split('@sha256:')[1]);
const env=c=>Object.fromEntries((c.environment??[]).map(x=>[x.name,x.value]));
const main=(t,kind)=>{const matches=t.containerDefinitions.filter(c=>env(c).PACKPROOF_PROCESS_ROLE===kind);check(matches.length===1,'CONNECT_RUNTIME_MAIN_CONTAINER_REQUIRED');return matches[0];};
const fresh=(at,now,age=900000)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&now-Date.parse(at)<=age;
const taskArn=value=>new RegExp(`^arn:aws:ecs:${TARGET.region}:${TARGET.account}:task-definition/[A-Za-z0-9_-]+:[0-9]+$`).test(value??'');
const taskFields=['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','pidMode','ipcMode','ephemeralStorage','runtimePlatform','enableFaultInjection'];
const responseFields=['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'];
function cloneTask(t){
 check(taskArn(t.taskDefinitionArn)&&t.networkMode==='awsvpc'&&t.requiresCompatibilities?.includes('FARGATE')&&t.containerDefinitions?.length>=1&&t.containerDefinitions.length<=2,'CONNECT_RUNTIME_TASK_SHAPE_REQUIRED');
 check(Object.keys(t).every(k=>taskFields.includes(k)||responseFields.includes(k)),'CONNECT_RUNTIME_UNKNOWN_TASK_FIELD');
 check((t.volumes??[]).every(v=>Object.keys(v).every(k=>k==='name'||k==='host'&&v.host&&typeof v.host==='object'&&!Array.isArray(v.host)&&Object.keys(v.host).length===0)),'CONNECT_RUNTIME_PERSISTENT_VOLUME_FORBIDDEN');
 check([t.taskRoleArn,t.executionRoleArn].every(v=>typeof v==='string'&&v.startsWith(`arn:aws:iam::${TARGET.account}:role/`)),'CONNECT_RUNTIME_ROLE_ACCOUNT_MISMATCH');
 for(const c of t.containerDefinitions){const names=[...(c.environment??[]),...(c.secrets??[])].map(x=>x.name);check(names.length===new Set(names).size&&!c.environmentFiles?.length,'CONNECT_RUNTIME_BINDINGS_AMBIGUOUS');}
 return Object.fromEntries(taskFields.filter(k=>k in t).map(k=>[k,structuredClone(t[k])]));
}
// ECS adds systemControls: [] to some registration responses. Only that exact
// empty default is equivalent to omission; preserve real requests and controls.
function taskConfigurationHash(t){
 const copy=structuredClone(t);
 for(const c of copy.containerDefinitions??[])if(Array.isArray(c.systemControls)&&c.systemControls.length===0)delete c.systemControls;
 return hash(copy);
}
function replaceRelease(c,r){
 const e=env(c);check(releaseNames.every(k=>Object.hasOwn(e,k))&&e.PACKPROOF_MIGRATE_ON_START==='false','CONNECT_RUNTIME_RELEASE_BINDINGS_REQUIRED');
 c.image=r.image;c.environment=c.environment.map(x=>releaseNames.includes(x.name)?{...x,value:({PACKPROOF_RELEASE_SHA:r.sourceSha,PACKPROOF_RELEASE_IMAGE:r.image,PACKPROOF_RELEASE_VERSION:r.version})[x.name]}:x);
}
function workerFixed(w){
 const t=cloneTask(w.taskDefinition);for(const c of t.containerDefinitions){delete c.image;if(c.environment)c.environment=c.environment.filter(x=>!releaseNames.includes(x.name));}
 return {task:t,service:Object.fromEntries(['serviceArn','clusterArn','desiredCount','deploymentConfiguration','networkConfiguration','capacityProviderStrategy','launchType','platformVersion','healthCheckGracePeriodSeconds','loadBalancers','enableExecuteCommand'].filter(k=>k in w.service).map(k=>[k,w.service[k]]))};
}
export function connectConfigurationLease(snapshot){return hash({api:snapshot.api.express.activeConfigurations,apiTask:snapshot.api.taskDefinition,worker:workerFixed(snapshot.worker),probe:snapshot.probe});}
function validate(snapshot,r,now){
 check((r?.schema==='packproof.connect-runtime-review/v1'||shipmentRelease(r))&&sha.test(r.sourceSha)&&image(r.image)&&/^[A-Za-z0-9._-]{1,100}$/.test(r.version??''),'CONNECT_RUNTIME_REVIEW_REQUIRED');
 check(fresh(snapshot.observedAt,now)&&Number.isFinite(Date.parse(r.expiresAt))&&Date.parse(r.expiresAt)>now&&Date.parse(r.expiresAt)-now<=7200000,'CONNECT_RUNTIME_OBSERVATION_EXPIRED');
 check(snapshot.account===TARGET.account&&snapshot.region===TARGET.region&&snapshot.api.service.serviceArn===TARGET.serviceArn,'CONNECT_RUNTIME_TARGET_MISMATCH');
 check(digest.test(r.topologySha256??'')&&hash(snapshot.topology)===r.topologySha256&&digest.test(r.configurationLeaseSha256??'')&&connectConfigurationLease(snapshot)===r.configurationLeaseSha256,'CONNECT_RUNTIME_CONFIGURATION_CHANGED');
 check(digest.test(r.probeNetworkSha256??'')&&hash(snapshot.probe)===r.probeNetworkSha256&&snapshot.probe?.clusterArn===r.probeClusterArn,'CONNECT_RUNTIME_PROBE_NETWORK_CHANGED');
 const w=snapshot.worker,e=r.expectedWorker;
 check(e&&e.serviceArn===w.service.serviceArn&&e.clusterArn===w.service.clusterArn&&new RegExp(`^arn:aws:ecs:${TARGET.region}:${TARGET.account}:service/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$`).test(e.serviceArn)&&new RegExp(`^arn:aws:ecs:${TARGET.region}:${TARGET.account}:cluster/[A-Za-z0-9_-]+$`).test(e.clusterArn),'CONNECT_RUNTIME_WORKER_IDENTITY_REQUIRED');
 check(w.service.status==='ACTIVE'&&w.service.desiredCount>=1&&w.service.runningCount===w.service.desiredCount&&w.service.pendingCount===0&&w.service.deployments?.length===1&&w.service.deployments[0].rolloutState==='COMPLETED','CONNECT_RUNTIME_WORKER_NOT_STABLE');
 check(w.service.taskDefinition===e.taskDefinition&&w.taskDefinition.taskDefinitionArn===e.taskDefinition&&image(e.image)&&w.taskDefinition.containerDefinitions.every(c=>c.image===e.image)&&env(main(w.taskDefinition,'worker')).PACKPROOF_RELEASE_SHA===e.sourceSha,'CONNECT_RUNTIME_WORKER_PREDECESSOR_CHANGED');
 check(sha.test(e.sourceSha??'')&&sha.test(r.expectedApi?.sourceSha??'')&&r.expectedApi.sourceSha===snapshot.api.meta.commit&&r.expectedApi.image===snapshot.api.meta.image&&r.expectedApi.taskDefinition===snapshot.api.service.taskDefinition,'CONNECT_RUNTIME_API_PREDECESSOR_CHANGED');
 check([r.apiRole,r.workerRole].every(v=>/^[a-z][a-z0-9_]{0,62}$/.test(v??''))&&r.apiRole!==r.workerRole,'CONNECT_RUNTIME_SEPARATE_LOGINS_REQUIRED');
 check(r.database?.host&&r.database.name&&['production','staging'].includes(r.environment)&&env(snapshot.api.express.activeConfigurations[0].primaryContainer).PACKPROOF_ENVIRONMENT===r.environment&&env(main(w.taskDefinition,'worker')).PACKPROOF_ENVIRONMENT===r.environment,'CONNECT_RUNTIME_DATABASE_REVIEW_REQUIRED');
 check(env(snapshot.api.express.activeConfigurations[0].primaryContainer).PACKPROOF_PROCESS_ROLE==='api'&&env(main(w.taskDefinition,'worker')).PACKPROOF_PROCESS_ROLE==='worker','CONNECT_RUNTIME_PROCESS_ROLES_REQUIRED');
 check(r.ciPassed===true&&r.sourceArchiveVerified===true&&digest.test(r.sourceArchiveSha256??'')&&r.inventorySha256===(shipmentRelease(r)?shipmentReleaseInventory(r):CONNECT_RUNTIME_INVENTORY.sha256),'CONNECT_RUNTIME_SOURCE_GATES_REQUIRED');
 cloneTask(snapshot.api.taskDefinition);cloneTask(w.taskDefinition);
 if(shipmentRelease(r))verifyShipmentDeploymentReview(snapshot,r,now);
}
function qualification(q,r,kind,now,expectedDefinition){
 const expectedContainers=expectedDefinition.containerDefinitions.map(c=>c.name),registered=q?.registered?.taskDefinition??q?.registered;
 check(taskArn(registered?.taskDefinitionArn)&&q?.task?.taskDefinitionArn===registered.taskDefinitionArn&&taskConfigurationHash(cloneTask(registered))===taskConfigurationHash(expectedDefinition),'CONNECT_RUNTIME_PROBE_DEFINITION_REQUIRED');
 const report=q?.report,task=q?.task;
 const previous=kind.startsWith('previous-'),role=previous?kind.slice(9):kind;
 const expectedImage=previous?(role==='api'?r.expectedApi.image:r.expectedWorker.image):r.image;
 const taskIdentity=shipmentRelease(r)&&!previous?report?.taskIdentity?.taskArn:report?.taskArn;
 check(typeof taskIdentity==='string'&&taskIdentity.startsWith(r.probeClusterArn.replace(':cluster/',':task/')+'/')&&task?.taskArn===taskIdentity&&task.clusterArn===r.probeClusterArn&&task.lastStatus==='STOPPED'&&task.containers?.length===expectedContainers.length&&hash(task.containers.map(c=>c.name).sort())===hash([...expectedContainers].sort())&&task.containers.every(c=>c.exitCode===0&&c.imageDigest===expectedImage.split('@')[1]),'CONNECT_RUNTIME_PROBE_TASK_RESULT_REQUIRED');
 if(shipmentRelease(r))return;
 check(report?.schema==='packproof.connect-runtime-probe/v1'&&report.kind===kind&&report.sourceSha===r.sourceSha&&report.image===r.image&&report.inventorySha256===CONNECT_RUNTIME_INVENTORY.sha256&&report.readOnly===true&&report.runtimeAuthorityUnchanged===true&&report.durabilityPolicyMatches===true&&report.compiledV2Guards===true&&fresh(report.completedAt,now),'CONNECT_RUNTIME_QUALIFICATION_REQUIRED');
 check(report.role===(kind==='api'?r.apiRole:r.workerRole)&&report.databaseHost===r.database.host&&report.databaseName===r.database.name&&report.environment===r.environment,'CONNECT_RUNTIME_PROBE_TARGET_MISMATCH');
 check(report.clusterArn===r.probeClusterArn&&taskArn(task.taskDefinitionArn),'CONNECT_RUNTIME_PROBE_CLUSTER_REQUIRED');
}
/** Both actual-login probes precede worker promotion. New workers retain v1 support. */
export function connectRuntimePlan(snapshot,r,probes,now=Date.now(),script){
 validate(snapshot,r,now);
 const definitions=connectProbeRegistrations(snapshot,r,script,now);
 for(const [kind,definition] of Object.entries(definitions))qualification(probes?.[kind],r,kind,now,definition);
 const shipmentPair=shipmentRelease(r)?verifyShipmentProbeReports(r,probes,now):null;
 const api=makePlan({...snapshot.api,account:snapshot.account,region:snapshot.region},{sourceSha:r.sourceSha,image:r.image,version:r.version,expectedPreviousImage:r.expectedApi.image,expectedPreviousTaskDefinition:r.expectedApi.taskDefinition,ciPassed:true,databasePreflightPassed:true,sourceArchiveVerified:true});
 const worker=cloneTask(snapshot.worker.taskDefinition);for(const c of worker.containerDefinitions){c.image=r.image;if(c===main(worker,'worker')||releaseNames.some(k=>Object.hasOwn(env(c),k)))replaceRelease(c,r);}
 check(hash(workerFixed({service:snapshot.worker.service,taskDefinition:{...worker,taskDefinitionArn:snapshot.worker.taskDefinition.taskDefinitionArn}}))===hash(workerFixed(snapshot.worker)),'CONNECT_RUNTIME_WORKER_PRESERVATION_FAILED');
 return {schema:shipmentPair?r.schema.replace('runtime-review','runtime-plan'):'packproof.connect-runtime-plan/v1',...(shipmentPair?{shipmentPair}:{}),sourceSha:r.sourceSha,image:r.image,reviewSha256:hash(r),configurationLeaseSha256:r.configurationLeaseSha256,preparedAt:new Date(now).toISOString(),expiresAt:r.expiresAt,apiConfigurationSha256:hash(snapshot.api.express.activeConfigurations),topologySha256:r.topologySha256,workerPredecessorSha256:hash(workerFixed(snapshot.worker)),workerPredecessorTaskDefinition:r.expectedWorker.taskDefinition,workerRegister:worker,apiUpdate:api.update,...(shipmentPair?{recovery:'Requalify the recovery images and reconcile admitted work before any reversal.'}:{rollbackApi:api.rollback,rollbackWorkerTaskDefinition:r.expectedWorker.taskDefinition}),workerServiceArn:r.expectedWorker.serviceArn,workerClusterArn:r.expectedWorker.clusterArn,order:['qualify_api_and_worker','promote_worker','verify_all_worker_tasks','promote_api','verify_public_identity_and_worker_health'],permittedChanges:['image','PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION']};
}
function planFresh(plan,now){check(['packproof.connect-runtime-plan/v1','packproof.connect-runtime-plan/v7','packproof.connect-runtime-plan/v8','packproof.connect-runtime-plan/v9','packproof.connect-runtime-plan/v10'].includes(plan?.schema)&&fresh(plan.preparedAt,now)&&Date.parse(plan.expiresAt)>now,'CONNECT_RUNTIME_PLAN_EXPIRED');}
export function connectWorkerRegistration(plan,now=Date.now()){planFresh(plan,now);return structuredClone(plan.workerRegister);}
export function connectWorkerUpdate(plan,registered,observation,now=Date.now()){
 planFresh(plan,now);
 check(fresh(observation?.observedAt,now)&&observation.service?.taskDefinition===plan.workerPredecessorTaskDefinition&&hash(workerFixed(observation))===plan.workerPredecessorSha256&&observation.service.runningCount===observation.service.desiredCount&&observation.service.pendingCount===0&&observation.service.deployments?.length===1&&observation.service.deployments[0].rolloutState==='COMPLETED','CONNECT_RUNTIME_WORKER_DRIFT');
 const t=registered?.taskDefinition??registered;
 check(taskArn(t?.taskDefinitionArn)&&taskConfigurationHash(cloneTask(t))===taskConfigurationHash(plan.workerRegister),'CONNECT_RUNTIME_REGISTERED_WORKER_MISMATCH');
 return {cluster:plan.workerClusterArn,service:plan.workerServiceArn,taskDefinition:t.taskDefinitionArn};
}
export function connectApiUpdate(plan,workerObservation,apiObservation,now=Date.now()){
 planFresh(plan,now);
 check(fresh(apiObservation?.observedAt,now)&&apiObservation.service?.serviceArn===TARGET.serviceArn&&apiObservation.service.runningCount===apiObservation.service.desiredCount&&apiObservation.service.pendingCount===0&&apiObservation.nativeDeploymentStatus==='SUCCESSFUL'&&hash(apiObservation.express?.activeConfigurations)===plan.apiConfigurationSha256&&hash(apiObservation.topology)===plan.topologySha256,'CONNECT_RUNTIME_API_DRIFT');
 const {service,tasks,taskDefinition,observedAt}=workerObservation??{};
 check(fresh(observedAt,now)&&service?.serviceArn===plan.workerServiceArn&&service.clusterArn===plan.workerClusterArn&&service.status==='ACTIVE'&&service.desiredCount>=1&&service.runningCount===service.desiredCount&&service.pendingCount===0&&service.deployments?.length===1&&service.deployments[0].rolloutState==='COMPLETED','CONNECT_RUNTIME_CANDIDATE_WORKER_NOT_STABLE');
 check(service.taskDefinition===taskDefinition?.taskDefinitionArn&&taskConfigurationHash(cloneTask(taskDefinition))===taskConfigurationHash(plan.workerRegister)&&tasks?.length===service.desiredCount&&tasks.every(t=>t.clusterArn===plan.workerClusterArn&&t.taskDefinitionArn===service.taskDefinition&&t.lastStatus==='RUNNING'&&t.containers?.length===plan.workerRegister.containerDefinitions.length&&hash(t.containers.map(c=>c.name).sort())===hash(plan.workerRegister.containerDefinitions.map(c=>c.name).sort())&&t.containers.every(c=>{const definition=plan.workerRegister.containerDefinitions.find(d=>d.name===c.name);return c.imageDigest===plan.image.split('@')[1]&&(env(definition).PACKPROOF_PROCESS_ROLE==='worker'?c.lastStatus==='RUNNING':c.lastStatus==='STOPPED'&&c.exitCode===0);})), 'CONNECT_RUNTIME_CANDIDATE_WORKER_DIGEST_REQUIRED');
 return structuredClone(plan.apiUpdate);
}
export function connectRollbackWorker(plan,apiObservation,quiescence,now=Date.now()){
 check(plan?.schema==='packproof.connect-runtime-plan/v1','SHIPMENT_ROLLBACK_NEEDS_NEW_PAIRED_REVIEW');
 check(fresh(apiObservation?.observedAt,now)&&apiObservation.stable===true&&hash(apiObservation.primaryContainer)===hash(plan.rollbackApi.primaryContainer),'CONNECT_RUNTIME_ROLLBACK_API_FIRST');
 check(fresh(quiescence?.observedAt,now)&&quiescence.readOnly===true&&quiescence.activeV2Sources===0&&quiescence.pendingV2Imports===0&&quiescence.databaseInspected===true,'CONNECT_RUNTIME_ROLLBACK_V2_QUIESCENCE_REQUIRED');
 return {cluster:plan.workerClusterArn,service:plan.workerServiceArn,taskDefinition:plan.rollbackWorkerTaskDefinition};
}
/** Register separately, then bind actual returned definitions before RunTask. Secrets stay in ECS refs. */
export function connectProbeRegistrations(snapshot,r,script,now=Date.now()){
 validate(snapshot,r,now);
 if(!shipmentRelease(r))check(typeof script==='string'&&script.includes('packproof.connect-runtime-probe/v1'),'CONNECT_RUNTIME_PROBE_CODE_REQUIRED');
 const output={};
 const labels=shipmentRelease(r)?['api','worker','previous-api','previous-worker']:['api','worker'];
 for(const label of labels){
  const reader=label.startsWith('previous-'),kind=reader?label.slice(9):label;
  const t=cloneTask(kind==='api'?snapshot.api.taskDefinition:snapshot.worker.taskDefinition),c=main(t,kind);for(const owned of t.containerDefinitions){check(owned.image===(kind==='api'?r.expectedApi.image:r.expectedWorker.image),'CONNECT_RUNTIME_UNREVIEWED_CONTAINER_IMAGE');if(!reader){owned.image=r.image;if(owned===c||releaseNames.some(k=>Object.hasOwn(env(owned),k)))replaceRelease(owned,r);}}
  t.family=`packproof-connect-probe-${r.sourceSha.slice(0,12)}-${label}`;
  const review={schema:'packproof.connect-runtime-probe-review/v1',sourceSha:r.sourceSha,image:r.image,kind,apiRole:r.apiRole,workerRole:r.workerRole,database:r.database,environment:r.environment,clusterArn:r.probeClusterArn};
  c.entryPoint=[];
  if(shipmentRelease(r))configureShipmentProbe(c,r,kind,reader,script);
  else c.command=['node','--input-type=module','-e',`process.argv=${JSON.stringify(['node','/tmp/connect-probe.mjs',JSON.stringify(review)])};\n${script}`];
  delete c.healthCheck;delete c.restartPolicy;
  check(c.logConfiguration?.logDriver==='awslogs'&&c.logConfiguration.options?.['awslogs-group']&&c.logConfiguration.options?.['awslogs-stream-prefix']&&c.logConfiguration.options?.['awslogs-region']===TARGET.region,'CONNECT_RUNTIME_PROBE_LOGS_REQUIRED');
  check(Buffer.byteLength(JSON.stringify(c.command))<7800,'CONNECT_RUNTIME_PROBE_COMMAND_TOO_LARGE');output[label]=t;
 }
 return output;
}
export function connectProbeRunRequest(snapshot,r,kind,registered,script,now=Date.now()){
 const definitions=connectProbeRegistrations(snapshot,r,script,now),t=registered?.taskDefinition??registered,p=snapshot.probe;
 check(definitions[kind]&&taskArn(t?.taskDefinitionArn)&&taskConfigurationHash(cloneTask(t))===taskConfigurationHash(definitions[kind]),'CONNECT_RUNTIME_PROBE_REGISTRATION_MISMATCH');
 check(p?.clusterArn===r.probeClusterArn&&new RegExp(`^arn:aws:ecs:${TARGET.region}:${TARGET.account}:cluster/[A-Za-z0-9_-]+$`).test(p.clusterArn)&&p.networkConfiguration?.awsvpcConfiguration?.subnets?.length&&p.networkConfiguration.awsvpcConfiguration.securityGroups?.length&&['ENABLED','DISABLED'].includes(p.networkConfiguration.awsvpcConfiguration.assignPublicIp),'CONNECT_RUNTIME_PROBE_NETWORK_REQUIRED');
 check(!p.capacityProviderStrategy?.length||p.capacityProviderStrategy.every(x=>['FARGATE','FARGATE_SPOT'].includes(x.capacityProvider)),'CONNECT_RUNTIME_PROBE_CAPACITY_REQUIRED');
 return {cluster:p.clusterArn,taskDefinition:t.taskDefinitionArn,count:1,networkConfiguration:structuredClone(p.networkConfiguration),...(p.capacityProviderStrategy?.length?{capacityProviderStrategy:structuredClone(p.capacityProviderStrategy)}:{launchType:'FARGATE'}),...(p.platformVersion?{platformVersion:p.platformVersion}:{}),enableExecuteCommand:false,clientToken:hash({review:r,kind}),startedBy:`connect-${r.sourceSha.slice(0,12)}-${kind}`,tags:[{key:'packproof-connect-release',value:r.sourceSha}]};
}
/** Root Docker layout; source is re-fetched and checksummed even for an unversioned bucket. */
export function connectRuntimeBuildRequest({sourceSha,archiveSha256,sourceVersion,predecessorImages,profile='zero-touch-v1',sourceTransport='s3'}){
 check(sourceTransport==='s3'||sourceTransport==='git-commit' && !sourceVersion && ['reconstruction-v10','order-workspace-bridge'].includes(profile),'CONNECT_RUNTIME_BUILD_TRANSPORT_REQUIRED');
 check(['zero-touch-v1','reconstruction-v7','reconstruction-v8','reconstruction-v9','reconstruction-v10','order-workspace-bridge'].includes(profile),'CONNECT_RUNTIME_BUILD_PROFILE_REQUIRED');
 const reviewedProfile=profile!=='zero-touch-v1';
 const inventories={'zero-touch-v1':CONNECT_RUNTIME_INVENTORY,'reconstruction-v7':shipmentRuntimeInventory,
  'reconstruction-v8':{count:121,sha256:backfillMigrationInventorySha256},'reconstruction-v9':{count:121,sha256:backfillMigrationInventorySha256}};
 const compatibility=profile==='order-workspace-bridge';
 const buildTag=compatibility?'order-compat-'+sourceSha:'connect-runtime-'+sourceSha;
 const inventory=compatibility?inventories['reconstruction-v9']:profile==='reconstruction-v10'?{count:122,sha256:workspaceInventory}:inventories[profile];
 const hosted=profile==='reconstruction-v9';
 const baseDigest=compatibility?'3722c462d1e35de35aea2bc94c71dc0a74a617e729d16da7baabe4e817d7cbf3':'cbccc2bca3c0efabd6fa957e48a95e4ee66009267914d342a073871e21dbf56b';
 const baseImage=TARGET.repository+'@sha256:'+baseDigest;
 const baseSha=compatibility?'c3880f6c2f6f5f56fe90fa1a64ddef6115e1dc39':'93274b085113dee70ee4fe7516b384cacfcd385e';
 const probeProfile=compatibility?'reconstruction-v9':profile;
 check(sha.test(sourceSha)&&digest.test(archiveSha256),'CONNECT_RUNTIME_BUILD_SOURCE_REQUIRED');
 check(Array.isArray(predecessorImages)&&predecessorImages.length>=1&&predecessorImages.length<=2&&predecessorImages.every(image),'CONNECT_RUNTIME_ROLLBACK_IMAGES_REQUIRED');
 const repository=TARGET.repository,key=`security-release/${sourceSha}/${archiveSha256}/backend.zip`;
 const verify=`docker run --rm -i --entrypoint node "$ECR:$IMAGE_TAG" --input-type=module <<'JS'\nimport {createHash} from 'node:crypto';\nimport {readFile} from 'node:fs/promises';\nimport {migrationInventory} from './dist/db/migrate.js';\nconst rows=(await migrationInventory()).map(({id,checksum})=>({id,checksum}));\nif(process.getuid()===0||rows.length!==${inventory.count}||createHash('sha256').update(JSON.stringify(rows)).digest('hex')!=='${inventory.sha256}')throw Error('CONNECT_RUNTIME_BUILD_INVENTORY_MISMATCH');\nfor(const file of ['dist/records/csv-semantics.js','dist/records/connect-csv-rules.json','/app/packages/evidence-contracts/package.json'])await readFile(file);\nif(!(await readFile('dist/records/agent-restrictions.js','utf8')).includes('packproof.scheduled-csv/v2'))throw Error('CONNECT_RUNTIME_BUILD_V2_GUARDS_REQUIRED');\n${reviewedProfile?`const {inspectReconstructionInventory}=await import('/release/${probeProfile}-release-review.mjs');
await import('/release/${probeProfile}-runtime-preflight.mjs');

${probeProfile==='reconstruction-v9'?"await import('/release/hosted-backfill-automation-pair.mjs');":''}
${profile==='reconstruction-v10'?"await import('/release/order-workspace-pair.mjs');await import('./dist/records/order-router.js');":''}
${compatibility?`const {isReviewedForwardCompatibleMigration:ready}=await import('./dist/db/forward-compatible-migrations.js');const row=${JSON.stringify(workspaceMigration)};if(!ready(row)||ready({...row,checksum:'0'.repeat(64)})||ready({...row,id:'124_unapproved'}))throw Error('COMPATIBILITY_GUARD_MISMATCH');`:''}
${profile==='reconstruction-v8'?"await import('/release/backfill-automation-pair.mjs');":''}
const full=await migrationInventory();
inspectReconstructionInventory(full,rows,{inventorySha256:'${inventory.sha256}'});
const {readShipmentAutomationPolicy}=await import('/release/shipment-automation-pair.mjs');
const policy=await readShipmentAutomationPolicy('api',{});
${hosted?"if(policy.bundleSha256!=='f76da56054275bb4e7b96446c1f2953846b476120e7441661cffd345297cd8a0')throw Error('HOSTED_BASE_APPLICATION_MISMATCH');":''}
console.log(JSON.stringify({event:'shipment_release_build_policy',bundleSha256:policy.bundleSha256}));\n`:''}console.log(JSON.stringify({event:'connect_runtime_image_verified',sourceSha:'${sourceSha}',archiveSha256:'${archiveSha256}',inventorySha256:'${inventory.sha256}',nonRoot:true}));\nJS`;
 const retention=`aws ecr get-lifecycle-policy --repository-name ${TARGET.serviceName} --output json > /tmp/connect-policy.json\naws ecr describe-images --repository-name ${TARGET.serviceName} --output json > /tmp/connect-images.json\nnode --input-type=module <<'JS'\nimport {readFileSync} from 'node:fs';\nconst policy=JSON.parse(JSON.parse(readFileSync('/tmp/connect-policy.json','utf8')).lifecyclePolicyText),images=JSON.parse(readFileSync('/tmp/connect-images.json','utf8')).imageDetails.sort((a,b)=>Date.parse(b.imagePushedAt)-Date.parse(a.imagePushedAt)),rule=policy.rules?.[0];\nif(policy.rules?.length!==1||rule.selection?.tagStatus!=='any'||rule.selection?.countType!=='imageCountMoreThan'||rule.action?.type!=='expire')throw Error('CONNECT_RUNTIME_RETENTION_REVIEW_REQUIRED');\nfor(const digest of ${JSON.stringify([...new Set([...predecessorImages,...(hosted||compatibility?[baseImage]:[])].map(v=>v.split('@')[1]))])}){const index=images.findIndex(x=>x.imageDigest===digest);if(index<0||index+2>rule.selection.countNumber)throw Error('CONNECT_RUNTIME_ROLLBACK_RETENTION_REQUIRED');}\nif(images.some(x=>x.imageTags?.includes('${buildTag}')))throw Error('CONNECT_RUNTIME_IMAGE_TAG_ALREADY_EXISTS');\nJS`;
 const buildImage=hosted||compatibility?[
  `docker pull '${baseImage}'`,
  `test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' '${baseImage}')" = '${baseSha}'`,
  `docker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" -t "$ECR:$IMAGE_TAG" -f backend/${compatibility?'Dockerfile.order-workspace-bridge':'Dockerfile.hosted-lock-profile'} .`
 ]:['docker build --label "org.opencontainers.image.revision=$REVIEWED_SOURCE_SHA" -t "$ECR:$IMAGE_TAG" -f backend/Dockerfile .'];
 const sourceCommands=sourceTransport==='git-commit'?[
  'git init -q /tmp/connect-source',
  'git -C /tmp/connect-source remote add origin https://github.com/thepackproof/packproof-v2.git',
  'GIT_TERMINAL_PROMPT=0 git -C /tmp/connect-source fetch --no-tags --depth=1 origin "$REVIEWED_SOURCE_SHA"',
  'git -C /tmp/connect-source checkout -q --detach FETCH_HEAD && test "$(git -C /tmp/connect-source rev-parse HEAD)" = "$REVIEWED_SOURCE_SHA"',
  '(cd /tmp/connect-source && python3 infra/backend-release/backend-source-archive.py "$REVIEWED_SOURCE_SHA" /tmp/connect-reviewed.zip reconstruction-v10 && python3 infra/backend-release/backend-source-archive.py "$REVIEWED_SOURCE_SHA" /tmp/connect-reviewed.zip reconstruction-v10 --verify)'
 ]:[`if [ -n "$SOURCE_OBJECT_VERSION" ]; then aws s3api get-object --bucket packproof-v2-staging-build-${TARGET.account} --key '${key}' --version-id "$SOURCE_OBJECT_VERSION" /tmp/connect-reviewed.zip; else aws s3api get-object --bucket packproof-v2-staging-build-${TARGET.account} --key '${key}' /tmp/connect-reviewed.zip; fi`];
 const buildspec=JSON.stringify({version:'0.2',phases:{pre_build:{'on-failure':'ABORT',commands:[`test "$(aws sts get-caller-identity --query Account --output text)" = ${TARGET.account}`,`test "$REVIEWED_SOURCE_SHA" = '${sourceSha}' && test "$IMAGE_TAG" = '${buildTag}'`,retention,...sourceCommands,`echo '${archiveSha256}  /tmp/connect-reviewed.zip' | sha256sum --check -`,'mkdir /tmp/connect-reviewed && python3 -m zipfile -e /tmp/connect-reviewed.zip /tmp/connect-reviewed',`ECR=${repository}; export ECR`,`aws ecr get-login-password --region ${TARGET.region} | docker login --username AWS --password-stdin ${TARGET.account}.dkr.ecr.${TARGET.region}.amazonaws.com`]},build:{'on-failure':'ABORT',commands:['cd /tmp/connect-reviewed','test -f backend/Dockerfile && test -f packages/evidence-contracts/package.json && test -f config/rnd/research-build.json',...buildImage,verify]},post_build:{'on-failure':'ABORT',commands:['test "$CODEBUILD_BUILD_SUCCEEDING" = 1','docker push "$ECR:$IMAGE_TAG"',`aws ecr batch-get-image --repository-name ${TARGET.serviceName} --image-ids "imageTag=$IMAGE_TAG" --query 'images[].imageId' --output json`]}}});
 const request=buildRequest({sourceSha,zipSha256:archiveSha256,sourceVersion,buildspec});
 request.environmentVariablesOverride[1].value=buildTag;
 if(sourceTransport==='git-commit'){
  request.sourceTypeOverride='NO_SOURCE';
  delete request.sourceLocationOverride;
 }else request.environmentVariablesOverride.push({name:'SOURCE_OBJECT_VERSION',value:sourceVersion??'',type:'PLAINTEXT'});
 return {...request,timeoutInMinutesOverride:30,queuedTimeoutInMinutesOverride:5,idempotencyToken:buildTag};
}
export const connectReleaseHash=hash;
