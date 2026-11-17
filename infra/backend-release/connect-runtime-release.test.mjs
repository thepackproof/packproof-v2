import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reconstructionDigest} from './reconstruction-v7-release-review.mjs';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {CONNECT_RUNTIME_INVENTORY,connectConfigurationLease,connectRuntimeBuildRequest,connectProbeRegistrations,connectProbeRunRequest,connectRuntimePlan,connectWorkerUpdate,connectApiUpdate,connectRollbackWorker} from './connect-runtime-release.mjs';
const now=Date.parse('2026-11-17T12:00:00Z'),at=new Date(now).toISOString(),source='b'.repeat(40),old='a'.repeat(40),image=`${TARGET.repository}@sha256:${'b'.repeat(64)}`,previous=`${TARGET.repository}@sha256:${'a'.repeat(64)}`;
const arn=(family,revision)=>`arn:aws:ecs:${TARGET.region}:${TARGET.account}:task-definition/${family}:${revision}`;
const cluster=`arn:aws:ecs:${TARGET.region}:${TARGET.account}:cluster/${TARGET.cluster}`,workerArn=`arn:aws:ecs:${TARGET.region}:${TARGET.account}:service/${TARGET.cluster}/observed-worker`;
const script=readFileSync(new URL('./connect-runtime-probe.mjs',import.meta.url),'utf8');
function task(kind){return{family:`existing-${kind}`,taskDefinitionArn:arn(`existing-${kind}`,2),revision:2,status:'ACTIVE',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],taskRoleArn:`arn:aws:iam::${TARGET.account}:role/Existing${kind}`,executionRoleArn:`arn:aws:iam::${TARGET.account}:role/ExistingExecution`,cpu:'1024',memory:'2048',volumes:kind==='worker'?[{name:'tmp'}]:[],containerDefinitions:[{name:kind,image:previous,readonlyRootFilesystem:true,environment:[{name:'PACKPROOF_MIGRATE_ON_START',value:'false'},{name:'PACKPROOF_PROCESS_ROLE',value:kind},{name:'PACKPROOF_ENVIRONMENT',value:'production'},{name:'PACKPROOF_RELEASE_SHA',value:old},{name:'PACKPROOF_RELEASE_IMAGE',value:previous},{name:'PACKPROOF_RELEASE_VERSION',value:'previous'},{name:'PACKPROOF_WEB_ORIGINS',value:'https://thepackproof.com'},{name:'PACKPROOF_PUBLIC_URL',value:'https://existing.invalid'},{name:'PRIVATE_CONFIGURATION',value:'preserve-without-stdout'}],secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'existing-runtime-reference'}],logConfiguration:{logDriver:'awslogs',options:{'awslogs-group':'/ecs/existing','awslogs-region':TARGET.region,'awslogs-stream-prefix':kind}},command:['node','dist/index.js']}]} }
function fixture(){
 const apiTask=task('api'),workerTask=task('worker'),networkConfiguration={awsvpcConfiguration:{subnets:['subnet-known'],securityGroups:['sg-known'],assignPublicIp:'DISABLED'}};
 const snapshot={observedAt:at,account:TARGET.account,region:TARGET.region,topology:{explicit:'reviewed'},api:{service:{serviceArn:TARGET.serviceArn,clusterArn:cluster,taskDefinition:apiTask.taskDefinitionArn,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,networkConfiguration},express:{serviceArn:TARGET.serviceArn,activeConfigurations:[{primaryContainer:structuredClone(apiTask.containerDefinitions[0]),cpu:'1024',memory:'2048'}]},taskDefinition:apiTask,meta:{commit:old,image:previous,version:'previous'},nativeDeploymentStatus:'SUCCESSFUL'},worker:{service:{serviceArn:workerArn,clusterArn:cluster,status:'ACTIVE',taskDefinition:workerTask.taskDefinitionArn,desiredCount:1,runningCount:1,pendingCount:0,deployments:[{rolloutState:'COMPLETED'}],networkConfiguration},taskDefinition:workerTask},probe:{clusterArn:cluster,networkConfiguration}};
 const review={schema:'packproof.connect-runtime-review/v1',sourceSha:source,image,version:'connect-0.2.1',expiresAt:new Date(now+3600000).toISOString(),topologySha256:hash(snapshot.topology),configurationLeaseSha256:connectConfigurationLease(snapshot),expectedApi:{sourceSha:old,image:previous,taskDefinition:apiTask.taskDefinitionArn},expectedWorker:{sourceSha:old,image:previous,taskDefinition:workerTask.taskDefinitionArn,serviceArn:workerArn,clusterArn:cluster},apiRole:'api_existing',workerRole:'worker_existing',database:{host:'reviewed.rds.amazonaws.com',name:'reviewed_database'},environment:'production',ciPassed:true,sourceArchiveVerified:true,sourceArchiveSha256:'c'.repeat(64),inventorySha256:CONNECT_RUNTIME_INVENTORY.sha256,probeClusterArn:cluster,probeNetworkSha256:hash(snapshot.probe)};
 const definitions=connectProbeRegistrations(snapshot,review,script,now);
 const probes=Object.fromEntries(['api','worker'].map(kind=>{const taskArn=`arn:aws:ecs:${TARGET.region}:${TARGET.account}:task/${TARGET.cluster}/${kind==='api'?'1':'2'.repeat(32)}`;return[kind,{registered:{...definitions[kind],taskDefinitionArn:arn('probe-'+kind,1)},report:{schema:'packproof.connect-runtime-probe/v1',kind,sourceSha:source,image,inventorySha256:CONNECT_RUNTIME_INVENTORY.sha256,readOnly:true,runtimeAuthorityUnchanged:true,durabilityPolicyMatches:true,compiledV2Guards:true,completedAt:at,role:kind==='api'?review.apiRole:review.workerRole,databaseHost:review.database.host,databaseName:review.database.name,environment:review.environment,taskArn,clusterArn:cluster},task:{taskArn,clusterArn:cluster,lastStatus:'STOPPED',taskDefinitionArn:arn('probe-'+kind,1),containers:[{name:kind,exitCode:0,imageDigest:image.split('@')[1]}]}}];}));
 return {snapshot,review,probes};
}
test('build uses root Git archive checksum, current108 inventory and rollback retention without deployment',()=>{
 const r=connectRuntimeBuildRequest({sourceSha:source,archiveSha256:'c'.repeat(64),predecessorImages:[previous]});
 assert.equal(r.projectName,TARGET.serviceName);assert.match(r.sourceLocationOverride,new RegExp(source));assert.equal(r.environmentVariablesOverride[1].value,`connect-runtime-${source}`);
 assert.match(r.buildspecOverride,/sha256sum --check/);assert.match(r.buildspecOverride,/-f backend\/Dockerfile/);assert.match(r.buildspecOverride,/CONNECT_RUNTIME_ROLLBACK_RETENTION_REQUIRED/);assert.match(r.buildspecOverride,/a873b3f50dc1d4a3/);assert.doesNotMatch(r.buildspecOverride,/update-service|migrate-cli|CREATE ROLE/);
 assert.throws(()=>connectRuntimeBuildRequest({sourceSha:source,archiveSha256:'c'.repeat(64)}),/ROLLBACK_IMAGES/);
});
test('probes preserve separate runtime credentials and run compact read-only code instead of main',()=>{
 const {snapshot,review}=fixture(),before=structuredClone(snapshot),p=connectProbeRegistrations(snapshot,review,script,now);
 assert.deepEqual(snapshot,before);
 for(const kind of ['api','worker']){
  const c=p[kind].containerDefinitions[0];assert.deepEqual(c.secrets,snapshot[kind==='api'?'api':'worker'].taskDefinition.containerDefinitions[0].secrets);assert.equal(c.image,image);assert.equal(c.command[0],'node');assert.ok(Buffer.byteLength(JSON.stringify(c.command))<7800);assert.ok(!c.command.join(' ').includes("import('/app/backend/dist/index.js')"));
  const registered={...p[kind],taskDefinitionArn:arn(p[kind].family,1)};const run=connectProbeRunRequest(snapshot,review,kind,registered,script,now);assert.equal(run.cluster,cluster);assert.equal(run.count,1);assert.equal(run.enableExecuteCommand,false);
 }
});
test('plan changes only image/release fields, requires both actual-image probes and preserves rollback',()=>{
 const {snapshot,review,probes}=fixture(),before=structuredClone(snapshot),p=connectRuntimePlan(snapshot,review,probes,now,script);
 assert.deepEqual(snapshot,before);assert.equal(p.workerRegister.containerDefinitions[0].image,image);assert.deepEqual(p.workerRegister.containerDefinitions[0].secrets,snapshot.worker.taskDefinition.containerDefinitions[0].secrets);assert.equal(p.rollbackApi.primaryContainer.image,previous);assert.equal(p.rollbackWorkerTaskDefinition,snapshot.worker.taskDefinition.taskDefinitionArn);
 delete probes.worker;assert.throws(()=>connectRuntimePlan(snapshot,review,probes,now,script),/PROBE_DEFINITION/);
});
test('worker first: API waits for every new worker digest and freshly unchanged API/topology',()=>{
 const {snapshot,review,probes}=fixture(),p=connectRuntimePlan(snapshot,review,probes,now,script),registered={...p.workerRegister,taskDefinitionArn:arn(p.workerRegister.family,3)};
 const workerUpdate=connectWorkerUpdate(p,registered,{...snapshot.worker,observedAt:at},now);assert.equal(workerUpdate.taskDefinition,registered.taskDefinitionArn);
 const observation={observedAt:at,service:{...snapshot.worker.service,taskDefinition:registered.taskDefinitionArn},taskDefinition:registered,tasks:[{clusterArn:cluster,taskDefinitionArn:registered.taskDefinitionArn,lastStatus:'RUNNING',containers:[{name:'worker',lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}]},api={...snapshot.api,observedAt:at,topology:snapshot.topology};
 assert.equal(connectApiUpdate(p,observation,api,now).primaryContainer.image,image);
 observation.tasks[0].containers[0].imageDigest=previous.split('@')[1];assert.throws(()=>connectApiUpdate(p,observation,api,now),/WORKER_DIGEST/);
 observation.tasks[0].containers[0].imageDigest=image.split('@')[1];api.express.activeConfigurations[0].primaryContainer.secrets[0].valueFrom='changed';assert.throws(()=>connectApiUpdate(p,observation,api,now),/API_DRIFT/);
});
test('fail closed on expired observations, predecessor/configuration changes, missing source gates and false probe task outcomes',()=>{
 for(const mutate of [s=>s.snapshot.observedAt=new Date(now-900001).toISOString(),s=>s.review.expectedWorker.taskDefinition=arn('other',1),s=>s.snapshot.worker.taskDefinition.containerDefinitions[0].environment.push({name:'UNREVIEWED',value:'changed'}),s=>s.probes.worker.task.containers[0].exitCode=1,s=>s.review.sourceArchiveVerified=false,s=>s.probes.api.report.databaseHost='another-db']){
  const f=fixture();mutate(f);assert.throws(()=>connectRuntimePlan(f.snapshot,f.review,f.probes,now,script));
 }
});
test('rollback worker requires restored API and quiesced v2 sources/accepted imports, retaining originals',()=>{
 const {snapshot,review,probes}=fixture(),p=connectRuntimePlan(snapshot,review,probes,now,script),api={observedAt:at,stable:true,primaryContainer:p.rollbackApi.primaryContainer},q={observedAt:at,readOnly:true,databaseInspected:true,activeV2Sources:0,pendingV2Imports:0};
 assert.equal(connectRollbackWorker(p,api,q,now).taskDefinition,p.rollbackWorkerTaskDefinition);assert.throws(()=>connectRollbackWorker(p,{...api,stable:false},q,now),/API_FIRST/);assert.throws(()=>connectRollbackWorker(p,api,{...q,pendingV2Imports:1},now),/QUIESCENCE/);
});
test('preserves an observed worker initializer and mounts while moving both owned images together',()=>{
 const f=fixture(),t=f.snapshot.worker.taskDefinition;
 t.volumes=[{name:'temporary',host:{}}];
 const init={name:'observed-init',image:previous,user:'0',essential:false,entryPoint:['/bin/sh','-c'],command:['chmod 1777 /tmp/work'],mountPoints:[{sourceVolume:'tmp',containerPath:'/tmp/work'}]};
 t.containerDefinitions.push(init);t.containerDefinitions[0].dependsOn=[{containerName:'observed-init',condition:'SUCCESS'}];t.containerDefinitions[0].mountPoints=[{sourceVolume:'tmp',containerPath:'/tmp/work'}];
 f.review.configurationLeaseSha256=connectConfigurationLease(f.snapshot);f.probes.worker.registered={...connectProbeRegistrations(f.snapshot,f.review,script,now).worker,taskDefinitionArn:f.probes.worker.task.taskDefinitionArn};f.probes.worker.task.containers.push({name:'observed-init',exitCode:0,imageDigest:image.split('@')[1]});
 const p=connectRuntimePlan(f.snapshot,f.review,f.probes,now,script);assert.equal(p.workerRegister.containerDefinitions[1].image,image);assert.deepEqual({...p.workerRegister.containerDefinitions[1],image:previous},init);assert.deepEqual(p.workerRegister.containerDefinitions[0].dependsOn,t.containerDefinitions[0].dependsOn);
 const probes=connectProbeRegistrations(f.snapshot,f.review,script,now);assert.equal(probes.worker.containerDefinitions[1].image,image);assert.deepEqual(probes.worker.containerDefinitions[1].command,init.command);
 const registered={...p.workerRegister,taskDefinitionArn:arn(p.workerRegister.family,3)},observation={observedAt:at,service:{...f.snapshot.worker.service,taskDefinition:registered.taskDefinitionArn},taskDefinition:registered,tasks:[{clusterArn:cluster,taskDefinitionArn:registered.taskDefinitionArn,lastStatus:'RUNNING',containers:[{name:'worker',lastStatus:'RUNNING',imageDigest:image.split('@')[1]},{name:'observed-init',lastStatus:'STOPPED',exitCode:0,imageDigest:image.split('@')[1]}]}]},api={...f.snapshot.api,observedAt:at,topology:f.snapshot.topology};
 assert.equal(connectApiUpdate(p,observation,api,now).primaryContainer.image,image);observation.tasks[0].containers[1].exitCode=1;assert.throws(()=>connectApiUpdate(p,observation,api,now),/WORKER_DIGEST/);
 assert.deepEqual(p.workerRegister.volumes,[{name:'temporary',host:{}}]);
 t.volumes[0].host.sourcePath='/host/data';f.review.configurationLeaseSha256='0'.repeat(64);assert.throws(()=>connectConfigurationLease(f.snapshot),/PERSISTENT_VOLUME/);
});

test('binds actual probe task definition to the generated roles, credentials, image and exact command',()=>{
 for(const mutate of [f=>f.probes.api.task.taskDefinitionArn=arn('different-probe',4),f=>f.probes.worker.registered.taskRoleArn=`arn:aws:iam::${TARGET.account}:role/UnreviewedRole`,f=>f.probes.api.registered.containerDefinitions[0].secrets[0].valueFrom='other-credential',f=>f.probes.worker.registered.containerDefinitions[0].command=['node','dist/index.js']]){const f=fixture();mutate(f);assert.throws(()=>connectRuntimePlan(f.snapshot,f.review,f.probes,now,script),/PROBE_DEFINITION/);}
});
test('leases and separately pins the complete probe cluster and network',()=>{
 const f=fixture(),lease=connectConfigurationLease(f.snapshot);f.snapshot.probe.networkConfiguration.awsvpcConfiguration.securityGroups=['sg-unreviewed'];assert.notEqual(connectConfigurationLease(f.snapshot),lease);assert.throws(()=>connectProbeRegistrations(f.snapshot,f.review,script,now),/CONFIGURATION_CHANGED/);
 f.review.configurationLeaseSha256=connectConfigurationLease(f.snapshot);assert.throws(()=>connectProbeRegistrations(f.snapshot,f.review,script,now),/PROBE_NETWORK_CHANGED/);
});
test('accepts only the observed empty ECS systemControls default without changing requests or weakening nonempty controls',()=>{
 const f=fixture();f.probes.api.registered.containerDefinitions[0].systemControls=[];
 assert.equal(connectProbeRunRequest(f.snapshot,f.review,'api',f.probes.api.registered,script,now).count,1);
 const plan=connectRuntimePlan(f.snapshot,f.review,f.probes,now,script),registered={...structuredClone(plan.workerRegister),taskDefinitionArn:arn(plan.workerRegister.family,3)};
 registered.containerDefinitions[0].systemControls=[];
 assert.equal(connectWorkerUpdate(plan,registered,{...f.snapshot.worker,observedAt:at},now).taskDefinition,registered.taskDefinitionArn);
 const observation={observedAt:at,service:{...f.snapshot.worker.service,taskDefinition:registered.taskDefinitionArn},taskDefinition:registered,tasks:[{clusterArn:cluster,taskDefinitionArn:registered.taskDefinitionArn,lastStatus:'RUNNING',containers:[{name:'worker',lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}]},api={...f.snapshot.api,observedAt:at,topology:f.snapshot.topology};
 assert.equal(connectApiUpdate(plan,observation,api,now).primaryContainer.image,image);
 assert.deepEqual(f.probes.api.registered.containerDefinitions[0].systemControls,[]);assert.deepEqual(registered.containerDefinitions[0].systemControls,[]);
 const nonempty=[{namespace:'net.ipv4.ip_forward',value:'1'}];f.probes.api.registered.containerDefinitions[0].systemControls=nonempty;
 assert.throws(()=>connectProbeRunRequest(f.snapshot,f.review,'api',f.probes.api.registered,script,now),/PROBE_REGISTRATION/);assert.throws(()=>connectRuntimePlan(f.snapshot,f.review,f.probes,now,script),/PROBE_DEFINITION/);
 registered.containerDefinitions[0].systemControls=nonempty;
 assert.throws(()=>connectWorkerUpdate(plan,registered,{...f.snapshot.worker,observedAt:at},now),/REGISTERED_WORKER/);assert.throws(()=>connectApiUpdate(plan,observation,api,now),/WORKER_DIGEST/);
});

function shipmentFixture(){
 const {snapshot,review:r}=fixture(),empty=hash([]),bundle='c'.repeat(64);
 const inventory='3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5';
 const records='276f345802fb758d75028be0e47b6fab3179c20927317cf30a58aa044e7364de';
 const v={schema:'packproof.reconstruction-release-review/v7',source,candidateImage:image,apiRole:r.apiRole,workerRole:r.workerRole,
  ownerRole:'reviewed_owner',clusterArn:cluster,target:{host:r.database.host,database:r.database.name},featureActivation:false,
  customerReleaseQualified:false,inventorySha256:inventory,recordsMigrationSha256:records,expiresAt:r.expiresAt,
  automationPolicy:{bundleSha256:bundle,interpretationVersion:'packproof.shipment-interpretation/v1',headerPolicyVersion:'same_names_any_order/v1',
   interpretationEnabled:false,headerVariantsEnabled:false,shadowSourcesSha256:empty}};
 const review={...r,schema:'packproof.connect-runtime-review/v7',inventorySha256:inventory,preflightReview:v};
 const code={reader:readFileSync(new URL('./shipment-rollback-reader-probe.mjs',import.meta.url),'utf8')};
 const definitions=connectProbeRegistrations(snapshot,review,code,now),probes={};
 for(const [index,[name,definition]] of Object.entries(definitions).entries()){
  const reader=name.startsWith('previous-'),kind=reader?name.slice(9):name,dbRole=kind==='api'?r.apiRole:r.workerRole;
  const taskArn=cluster.replace(':cluster/',':task/')+'/'+String(index+1).repeat(32),i=reader?previous:image;
  const registered={...definition,taskDefinitionArn:arn(definition.family,3)};
  const shared={kind,completedAt:at,readOnly:true,reviewSha256:reconstructionDigest(v)};
  const report=reader?{...shared,schema:'packproof.shipment-rollback-reader/v1',role:dbRole,image:i,sourceSha:old,
   environment:r.environment,databaseHost:r.database.host,databaseName:r.database.name,clusterArn:cluster,taskArn,
   inventorySha256:inventory,compatibleReader:true}:{...shared,schema:'packproof.reconstruction-runtime-preflight/v7',
   source,customerReleaseQualified:false,identity:{role:dbRole,login:dbRole,read_only:'on',schema:'public',database:r.database.name},
   taskIdentity:{taskArn,image:i,imageDigest:i.split('@')[1]},sourceInventory:{sourceCount:120,appliedCount:120,
    inventorySha256:inventory,migrationsApplied:false,rolesChanged:false,featureActivation:false},
   durabilityPolicyMatches:true,tls:{ssl:true},immutableTriggerVerified:true,m2PrivilegesSha256:'f'.repeat(64),
   recordsPrivileges:{migrationSha256:records,sourceCommit:source,caller:dbRole},
   automationPolicy:{...v.automationPolicy,schema:'packproof.shipment-policy-role/v1',kind,shadowSourceCount:0}};
  probes[name]={report,registered,task:{taskArn,clusterArn:cluster,lastStatus:'STOPPED',taskDefinitionArn:registered.taskDefinitionArn,
   containers:definition.containerDefinitions.map(c=>({name:c.name,exitCode:0,imageDigest:i.split('@')[1]}))}};
 }
 return {snapshot,review,code,definitions,probes};
}
test('v7 build pins the full reviewed inventory and opens the compiled policy before any push',()=>{
 const built=connectRuntimeBuildRequest({sourceSha:source,archiveSha256:'c'.repeat(64),predecessorImages:[previous],profile:'reconstruction-v7'});
 const phases=JSON.parse(built.buildspecOverride).phases,checks=phases.build.commands.join('\n');
 for(const expected of ['rows.length!==120','3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5',
  'inspectReconstructionInventory','reconstruction-v7-runtime-preflight.mjs','readShipmentAutomationPolicy'])assert.ok(checks.includes(expected));
 assert.ok(phases.post_build.commands.includes('test "$CODEBUILD_BUILD_SUCCEEDING" = 1'));
 assert.throws(()=>connectRuntimeBuildRequest({profile:'unknown'}),/PROFILE_REQUIRED/);
});
test('v7 binds both actual logins and both exact recovery readers to their commands and images',()=>{
 const {snapshot,review,code,definitions,probes}=shipmentFixture();
 for(const [name,t] of Object.entries(definitions)){
  const prior=name.startsWith('previous-'),kind=prior?name.slice(9):name,main=t.containerDefinitions[0];
  assert.equal(main.image,prior?previous:image);assert.ok(JSON.stringify(main.command).length<7800);
  if(prior)assert.match(main.command.at(-1),/runRollbackReaderProbe/);
  else {assert.deepEqual(main.command,['node','/release/reconstruction-v7-runtime-preflight.mjs',kind]);assert.ok(main.environment.some(e=>e.name==='PACKPROOF_RECONSTRUCTION_V7_REVIEW_SHA256'&&e.value===reconstructionDigest(review.preflightReview)));}
  assert.equal(connectProbeRunRequest(snapshot,review,name,probes[name].registered,code,now).taskDefinition,probes[name].registered.taskDefinitionArn);
 }
 const plan=connectRuntimePlan(snapshot,review,probes,now,code);
 assert.equal(plan.schema,'packproof.connect-runtime-plan/v7');assert.equal(plan.shipmentPair.featureActivation,false);
 assert.equal(plan.rollbackApi,undefined);assert.throws(()=>connectRollbackWorker(plan,{},{}),/ROLLBACK_NEEDS_NEW_PAIRED_REVIEW/);
 assert.throws(()=>connectProbeRegistrations(snapshot,review,{reader:'stub'},now),/SHIPMENT_READER_PROBE_CODE_REQUIRED/);
});
test('v7 rejects incompatible readers, hidden activation, substitutions, drift and partial or stale evidence',()=>{
 for(const mutate of [
  f=>{delete f.probes['previous-worker'];},f=>{f.probes['previous-api'].report.compatibleReader=false;},
  f=>{f.probes['previous-api'].report.sourceSha=source;},f=>{f.probes['previous-worker'].task.containers[0].imageDigest=image.split('@')[1];},
  f=>{f.probes['previous-worker'].report.completedAt='2026-11-17T11:10:00Z';},
  f=>{f.probes.worker.report.automationPolicy.interpretationEnabled=true;},f=>{f.probes.worker.report.automationPolicy.shadowSourceCount=1;},
  f=>{f.probes.api.report.immutableTriggerVerified=false;},f=>{f.probes.api.registered.containerDefinitions[0].command=['node','dist/index.js'];},
  f=>{f.review.preflightReview.source=old;},f=>{f.review.preflightReview.recordsMigrationSha256='0'.repeat(64);},
  f=>{f.review.preflightReview.automationPolicy.headerVariantsEnabled=true;},
  f=>{const c=f.snapshot.worker.taskDefinition.containerDefinitions[0];c.environment.push({name:'PACKPROOF_SOURCE_IDENTITY_V2_ENABLED',value:'true'});f.review.configurationLeaseSha256=connectConfigurationLease(f.snapshot);},
  f=>{const c=f.snapshot.worker.taskDefinition.containerDefinitions[0];c.secrets.push({name:'PACKPROOF_CSV_HEADER_VARIANTS_ENABLED',valueFrom:'opaque'});f.review.configurationLeaseSha256=connectConfigurationLease(f.snapshot);}
 ]){
  const f=shipmentFixture();mutate(f);assert.throws(()=>connectRuntimePlan(f.snapshot,f.review,f.probes,now,f.code),
   /(?:AUTOMATION_|SHIPMENT_|CONNECT_RUNTIME_|RECONSTRUCTION_)/);
 }
});
