import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectCollectorVersionPair} from './collector-version-pair.mjs';
import {collectorGrants,collectorInventory,collectorMigration,collectorRecords} from './reconstruction-v11-release-review.mjs';
import {workspaceInventory} from './reconstruction-v10-release-review.mjs';
import {reconstructionDigest} from './reconstruction-v7-release-review.mjs';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {CONNECT_RUNTIME_INVENTORY,connectConfigurationLease,connectRuntimeBuildRequest,connectProbeRegistrations,connectProbeRunRequest,connectRuntimePlan,connectWorkerRegistration,connectWorkerUpdate,connectApiUpdate,connectRollbackWorker,connectWorkspaceSwitch,connectRecoveryProbe,connectRecoveryUpdate} from './connect-runtime-release.mjs';
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

function shipmentFixture(version='v7',preserve=false){
 const hostedCollector=version==='v11-hosted',workspace=version==='v10'||hostedCollector,backfill=workspace||version==='v8'||version==='v9';
 const {snapshot,review:r}=fixture(),empty=hash([]),bundle='c'.repeat(64);
 if(hostedCollector){
  r.database={host:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',name:'packproof_v2'};
  for(const container of [snapshot.api.express.activeConfigurations[0].primaryContainer,...snapshot.api.taskDefinition.containerDefinitions,...snapshot.worker.taskDefinition.containerDefinitions]){
   container.environment.find(binding=>binding.name==='PACKPROOF_RELEASE_SHA').value=source;
  }
  snapshot.api.meta.commit=source;r.expectedApi.sourceSha=source;r.expectedWorker.sourceSha=source;
  r.configurationLeaseSha256=connectConfigurationLease(snapshot);
 }
 if(preserve){
  for(const c of [snapshot.api.express.activeConfigurations[0].primaryContainer,snapshot.api.taskDefinition.containerDefinitions[0],snapshot.worker.taskDefinition.containerDefinitions[0]]){
   c.environment.push({name:'PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED',value:'true'},{name:'PACKPROOF_SHIPMENT_WORKER_INTERPRETATION',value:'packproof.shipment-interpretation/v1'});
  }
  r.configurationLeaseSha256=connectConfigurationLease(snapshot);
 }
 const inventory=hostedCollector?collectorInventory:workspace?'ce2f00a3cee6b8139fc6323830e787e781dab7780da93c8d4b23deaa742c1b4d':backfill?'ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804':'3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5';
 const records=hostedCollector?collectorRecords:workspace?'fc90a9edbe22cc22fa5f553096d9d7b9da8a3bde62ad3784ef117abdb6147001':backfill?'11b3a0e163438a2ea9f8122f76857866154be6b901b4abbcec4cf780d0625f38':'276f345802fb758d75028be0e47b6fab3179c20927317cf30a58aa044e7364de';
 const v={schema:`packproof.reconstruction-release-review/${version}`,...(backfill?{backfillJobsEnabled:false}:{}),...(workspace?{orderWorkspaceEnabled:false}:{}),...(workspace||version==='v9'?{platformLockPolicySha256:'cc1ff79558beac7c7178ccaecdb9c2138e7271077c8df15ff7950a73e6baf743'}:{}),source,candidateImage:image,apiRole:r.apiRole,workerRole:r.workerRole,
  ownerRole:'reviewed_owner',clusterArn:cluster,target:{host:r.database.host,database:r.database.name},featureActivation:false,
  customerReleaseQualified:false,inventorySha256:inventory,recordsMigrationSha256:records,expiresAt:r.expiresAt,
  automationPolicy:{bundleSha256:bundle,interpretationVersion:'packproof.shipment-interpretation/v1',headerPolicyVersion:'same_names_any_order/v1',
   interpretationEnabled:preserve,headerVariantsEnabled:false,shadowSourcesSha256:empty},...(preserve?{preserveShipmentSettings:true}:{})};
 const review={...r,schema:`packproof.connect-runtime-review/${version}`,inventorySha256:inventory,preflightReview:v};
 const code={reader:readFileSync(new URL(workspace?'./order-workspace-rollback-reader.mjs':backfill?'./backfill-rollback-reader-probe.mjs':'./shipment-rollback-reader-probe.mjs',import.meta.url),'utf8')};
 const definitions=connectProbeRegistrations(snapshot,review,code,now),probes={};
 for(const [index,[name,definition]] of Object.entries(definitions).entries()){
  const reader=name.startsWith('previous-'),kind=reader?name.slice(9):name,dbRole=kind==='api'?r.apiRole:r.workerRole;
  const taskArn=cluster.replace(':cluster/',':task/')+'/'+String(index+1).repeat(32),i=reader?previous:image;
  const registered={...definition,taskDefinitionArn:arn(definition.family,3)};
  const shared={kind,completedAt:at,readOnly:true,reviewSha256:reconstructionDigest(v)};
  const report=reader?{...shared,schema:hostedCollector?'packproof.hosted-collector-rollback-reader/v1':workspace?'packproof.order-workspace-rollback-reader/v1':backfill?'packproof.backfill-rollback-reader/v1':'packproof.shipment-rollback-reader/v1',role:dbRole,image:i,sourceSha:hostedCollector?source:old,
   environment:r.environment,databaseHost:r.database.host,databaseName:r.database.name,clusterArn:cluster,taskArn,
   inventorySha256:inventory,compatibleReader:true}:{...shared,schema:`packproof.reconstruction-runtime-preflight/${version}`,...(backfill?{backfillJobsEnabled:false,backfillScopeVerified:true}:{}),...(workspace?{orderWorkspaceEnabled:false,orderHistoryGuardsVerified:true}:{}),
   source,customerReleaseQualified:false,identity:{role:dbRole,login:dbRole,read_only:'on',schema:'public',database:r.database.name},
   taskIdentity:{taskArn,image:i,imageDigest:i.split('@')[1]},sourceInventory:{sourceCount:workspace?122:backfill?121:120,appliedCount:workspace?122:backfill?121:120,
    inventorySha256:inventory,migrationsApplied:false,rolesChanged:false,featureActivation:false},
   durabilityPolicyMatches:true,tls:{ssl:true},immutableTriggerVerified:true,m2PrivilegesSha256:'f'.repeat(64),
   recordsPrivileges:{migrationSha256:records,sourceCommit:source,caller:dbRole},
   automationPolicy:{...v.automationPolicy,schema:'packproof.shipment-policy-role/v1',kind,shadowSourceCount:0,...(preserve?{workerInterpretation:v.automationPolicy.interpretationVersion}:{})}};
  if(hostedCollector&&!reader){
   report.collectorVersionVerified=true;
   Object.assign(report.recordsPrivileges,{policySha256:collectorGrants,effectivePrivilegesSha256:'d'.repeat(64)});
   Object.assign(report.sourceInventory,{sourceCount:123,appliedCount:123,predecessorSha256:workspaceInventory,additions:[collectorMigration]});
  }
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
test('v8 build verifies the separate 122 inventory and both runtime and pair entry points',()=>{
 const built=connectRuntimeBuildRequest({sourceSha:source,archiveSha256:'c'.repeat(64),predecessorImages:[previous],profile:'reconstruction-v8'});
 const checks=JSON.parse(built.buildspecOverride).phases.build.commands.join('\n');
 for(const expected of ['rows.length!==121','ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804',
  'reconstruction-v8-runtime-preflight.mjs','backfill-automation-pair.mjs'])assert.ok(checks.includes(expected));
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
test('v8 default-off deployment planning binds both 122 roles and both exact recovery readers',()=>{
 const f=shipmentFixture('v8');
 for(const [name,t] of Object.entries(f.definitions)){
  const prior=name.startsWith('previous-'),kind=prior?name.slice(9):name,main=t.containerDefinitions[0];
  assert.ok(JSON.stringify(main.command).length<7800);
  if(!prior)assert.deepEqual(main.command,['node','/release/reconstruction-v8-runtime-preflight.mjs',kind]);
  assert.equal(connectProbeRunRequest(f.snapshot,f.review,name,f.probes[name].registered,f.code,now).taskDefinition,f.probes[name].registered.taskDefinitionArn);
 }
 const prepare=()=>connectRuntimePlan(f.snapshot,f.review,f.probes,now,f.code);
 assert.equal(prepare().schema,'packproof.connect-runtime-plan/v8');
 f.probes['previous-api'].report.schema='packproof.shipment-rollback-reader/v1';
 assert.throws(prepare,/COMPATIBLE_PREDECESSOR/);
 assert.throws(()=>connectProbeRegistrations(f.snapshot,f.review,shipmentFixture().code,now),/READER_PROBE_CODE/);
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

function addHostedLocks(probes,review){
 for(const kind of ['api','worker']){
  probes[kind].report.platformLocks={
   schema:'packproof.hosted-platform-lock-observation/v1',role:probes[kind].report.identity.role,
   policySha256:review.preflightReview.platformLockPolicySha256,
   membership:{selectTable:true,updateTable:false,updateColumns:['revoked_at'],grantableUpdate:false,idMutable:false,
    triggerSha256:'85290fcfa99548c8c15bac587a335bfb30fa35589a76776b63390225fbe63dd6',
    functionSha256:'981746c709450f6ee117421020f623cfedb9a60591176037df75d12b9b30f774',
    bodySha256:'cf116d09c6fb507a38a9f4cfa7cb74a897ee31e0cf4184ef1ec5c13425cf2bf7'},
   proof:{idUpdate:true,idUpdateGrantable:false},
   membershipLock:{mode:'EXPLAIN WITHOUT ANALYZE',authorized:true,plan:'LockRows/Result/false',readOnlyTransaction:true,statementExecuted:false},
   grantsApplied:false};
 }
}
test('v9 preserves the four-image-role review and binds the legacy hosted membership observation per login',()=>{
 const f=shipmentFixture('v9'), {probes,review,snapshot,code}=f;
 addHostedLocks(probes,review);
 for(const kind of ['api','worker']){
  assert.deepEqual(f.definitions[kind].containerDefinitions[0].command,['node','/release/reconstruction-v9-runtime-preflight.mjs',kind]);
  for(const name of [kind,'previous-'+kind])
   assert.equal(connectProbeRunRequest(snapshot,review,name,probes[name].registered,code,now).taskDefinition,probes[name].registered.taskDefinitionArn);
 }
 const plan=connectRuntimePlan(snapshot,review,probes,now,code);
 assert.equal(plan.schema,'packproof.connect-runtime-plan/v9');
 assert.equal(plan.shipmentPair.platformLockPolicySha256,review.preflightReview.platformLockPolicySha256);
 assert.ok(connectWorkerRegistration(plan,now).containerDefinitions.length);
 assert.throws(()=>connectRollbackWorker(plan,{},{}),/ROLLBACK_NEEDS_NEW_PAIRED_REVIEW/);
 for(const change of [
  reports=>{reports.worker.report.platformLocks.membership.updateColumns.push('id')},
  reports=>{reports.worker.report.platformLocks.membership.grantableUpdate=true},
  reports=>{reports.worker.report.platformLocks.role=reports.api.report.identity.role},
  reports=>{reports.worker.report.platformLocks.membershipLock.statementExecuted=true},
  reports=>{reports.api.report.platformLocks.membership.bodySha256='e'.repeat(64)},
  reports=>{reports.api.report.schema='packproof.reconstruction-runtime-preflight/v8'},
  reports=>{reports['previous-worker'].report.compatibleReader=false}
 ]){
  const invalid=structuredClone(probes);change(invalid);
  assert.throws(()=>connectRuntimePlan(snapshot,review,invalid,now,code),/EVIDENCE_MISMATCH|ROLE_RECEIPT|COMPATIBLE_PREDECESSOR/);
 }
 const request=connectRuntimeBuildRequest({sourceSha:source,archiveSha256:'c'.repeat(64),predecessorImages:[previous],profile:'reconstruction-v9'});
 const build=JSON.parse(request.buildspecOverride).phases.build.commands.join('\n');
 for(const value of ['reconstruction-v9-runtime-preflight.mjs','Dockerfile.hosted-lock-profile','hosted-backfill-automation-pair.mjs','rows.length!==121'])
  assert.ok(build.includes(value));
});

test('four-role reviews can preserve the exact approved shipment policy on API and worker',()=>{
 for(const version of ['v9','v10']){
  const {snapshot,review,probes,code}=shipmentFixture(version,true);
  addHostedLocks(probes,review);
  assert.equal(connectRuntimePlan(snapshot,review,probes,now,code).schema,'packproof.connect-runtime-plan/'+version);
  const off=structuredClone(review);delete off.preflightReview.preserveShipmentSettings;
  assert.throws(()=>connectRuntimePlan(snapshot,off,probes,now,code),/DEFAULT_OFF_REVIEW/);
  const altered=structuredClone(snapshot);
  altered.worker.taskDefinition.containerDefinitions[0].environment.find(e=>e.name==='PACKPROOF_SHIPMENT_WORKER_INTERPRETATION').value='other';
  assert.throws(()=>connectRuntimePlan(altered,{...review,configurationLeaseSha256:connectConfigurationLease(altered)},probes,now,code),/EXISTING_APPROVAL/);
 }
});

test('CodeBuild fetches an exact reviewed public Git commit and verifies independently reproduced archive bytes',()=>{
 const input={sourceSha:source,archiveSha256:'a'.repeat(64),predecessorImages:[previous],sourceTransport:'git-commit'};
 for(const profile of ['order-workspace-bridge','reconstruction-v10']){
  const request=connectRuntimeBuildRequest({...input,profile}),spec=JSON.parse(request.buildspecOverride);
  assert.equal(request.sourceTypeOverride,'NO_SOURCE');
  assert.equal(request.sourceLocationOverride,undefined);
  const commands=spec.phases.pre_build.commands.join('\n');
  for(const value of ['https://github.com/thepackproof/packproof-v2.git','rev-parse HEAD','reconstruction-v10 --verify',input.archiveSha256,'sha256sum --check'])assert.ok(commands.includes(value));
  assert.doesNotMatch(commands,/s3api/);
  assert.equal(spec.phases.post_build.commands[0],'test "$CODEBUILD_BUILD_SUCCEEDING" = 1');
 }
 assert.throws(()=>connectRuntimeBuildRequest({...input,profile:'reconstruction-v10',sourceVersion:'object-version'}),/TRANSPORT/);
 assert.throws(()=>connectRuntimeBuildRequest({...input,profile:'reconstruction-v7'}),/TRANSPORT/);
});

test('123 release binds both real roles, exact rollback readers, scope guards and separate compatibility image',()=>{
 const {snapshot,review,probes,code}=shipmentFixture('v10');
 addHostedLocks(probes,review);
 assert.equal(connectRuntimePlan(snapshot,review,probes,now,code).schema,'packproof.connect-runtime-plan/v10');
 for(const kind of ['api','worker']){
  const changed=structuredClone(probes);changed[kind].report.orderHistoryGuardsVerified=false;
  assert.throws(()=>connectRuntimePlan(snapshot,review,changed,now,code),/ROLE_RECEIPT_MISMATCH/);
 }
 const input={sourceSha:source,archiveSha256:'a'.repeat(64),predecessorImages:[previous]};
 const bridge=connectRuntimeBuildRequest({...input,profile:'order-workspace-bridge'});
 const candidate=connectRuntimeBuildRequest({...input,profile:'reconstruction-v10'});
 assert.notEqual(bridge.idempotencyToken,candidate.idempotencyToken);
 for(const text of ['Dockerfile.order-workspace-bridge','COMPATIBILITY_GUARD_MISMATCH','c3880f6c2f6f5f56fe90fa1a64ddef6115e1dc39','3722c462d1e35de35aea2bc94c71dc0a74a617e729d16da7baabe4e817d7cbf3'])
  assert.ok(bridge.buildspecOverride.includes(text));
 for(const text of ['order-workspace-pair.mjs','reconstruction-v10-runtime-preflight.mjs','rows.length!==122','./dist/records/order-router.js'])
  assert.ok(candidate.buildspecOverride.includes(text));
});


test('124 builds the application from the verified v11 source without constructing a bridge or deployment',()=>{
 const input={sourceSha:source,archiveSha256:'a'.repeat(64),predecessorImages:[previous],profile:'reconstruction-v11'};
 for(const sourceTransport of ['s3','git-commit']){
  const request=connectRuntimeBuildRequest({...input,sourceTransport});
  const phases=JSON.parse(request.buildspecOverride).phases;
  const build=phases.build.commands.join('\n'),prepare=phases.pre_build.commands.join('\n');
  for(const text of [collectorInventory,'rows.length!==123','reconstruction-v11-release-review.mjs','reconstruction-v11-runtime-preflight.mjs',
   'collector-version-pair.mjs','./dist/records/order-router.js','./dist/records/order-source.js'])assert.ok(build.includes(text),text);
  assert.doesNotMatch(build,/Dockerfile.order-workspace-bridge|update-service|migrate-cli/);
  assert.ok(prepare.includes(input.archiveSha256));
  if(sourceTransport==='git-commit')assert.match(prepare,/reconstruction-v11 --verify/);
  assert.equal(phases.post_build.commands[0],'test "$CODEBUILD_BUILD_SUCCEEDING" = 1');
 }
 const f=fixture(),review={...f.review,schema:'packproof.connect-runtime-review/v11'};
 assert.throws(()=>connectProbeRegistrations(f.snapshot,review,script,now),/REVIEW_REQUIRED/);
 assert.throws(()=>connectRuntimePlan(f.snapshot,review,{},now,script),/REVIEW_REQUIRED/);
});

test('124 pairs fresh independent restored logins and rejects drift in either privilege or scope receipt',()=>{
 const f=shipmentFixture('v10');
 addHostedLocks(f.probes,f.review);
 const restoreCluster=cluster.replace(/\/[^/]+$/,'/collector-rehearsal');
 const review={...f.review.preflightReview,schema:'packproof.reconstruction-release-review/v11',clusterArn:restoreCluster,
  inventorySha256:collectorInventory,recordsMigrationSha256:collectorRecords};
 const receipts=['api','worker'].map(kind=>{
  const value=structuredClone(f.probes[kind].report);
  value.schema='packproof.reconstruction-runtime-preflight/v11';
  value.reviewSha256=reconstructionDigest(review);
  value.taskIdentity.taskArn=value.taskIdentity.taskArn.replace(cluster.split('/').at(-1),'collector-rehearsal');
  Object.assign(value.sourceInventory,{sourceCount:123,appliedCount:123,inventorySha256:collectorInventory,
    predecessorSha256:workspaceInventory,additions:[collectorMigration]});
  Object.assign(value.recordsPrivileges,{migrationSha256:collectorRecords,policySha256:collectorGrants,effectivePrivilegesSha256:'e'.repeat(64)});
  value.collectorVersionVerified=true;
  return value;
 });
 const pair=(api,worker)=>inspectCollectorVersionPair(review,api,worker,new Date(now));
 const result=pair(...receipts);
 assert.equal(result.schema,'packproof.collector-version-policy-pair/v1');
 assert.equal(result.customerReleaseQualified,false);
 assert.equal(result.apiReceiptSha256,reconstructionDigest(receipts[0]));
 assert.equal(result.workerReceiptSha256,reconstructionDigest(receipts[1]));
 for(const i of [0,1])for(const change of [
  r=>{r.collectorVersionVerified=false;},r=>{r.orderHistoryGuardsVerified=false;},r=>{r.backfillScopeVerified=false;},
  r=>{r.recordsPrivileges.policySha256='0'.repeat(64);},r=>{r.recordsPrivileges.effectivePrivilegesSha256='0'.repeat(64);},
  r=>{r.sourceInventory.predecessorSha256='f'.repeat(64);},r=>{r.sourceInventory.additions=[];},
  r=>{r.schema='packproof.reconstruction-runtime-preflight/v10';},r=>{r.identity.login='other';},
  r=>{r.automationPolicy.shadowSourcesSha256='c'.repeat(64);}
 ]){
  const altered=structuredClone(receipts);change(altered[i]);
  assert.throws(()=>pair(...altered),/MISMATCH/);
 }
});

test('hosted collector promotes with all four real-role receipts and enables only its API switch',()=>{
 const {snapshot,review,probes,code,definitions}=shipmentFixture('v11-hosted',true);
 addHostedLocks(probes,review);
 const plan=connectRuntimePlan(snapshot,review,probes,now,code);
 assert.equal(plan.schema,'packproof.connect-runtime-plan/v11-hosted');
 assert.equal(plan.shipmentPair.collectorVersionVerified,true);
 const api=structuredClone(snapshot.api);
 api.express.activeConfigurations[0].primaryContainer=plan.apiUpdate.primaryContainer;
 api.meta={image,commit:source};
 api.observedAt=at;
 api.tasks=[{lastStatus:'RUNNING',taskDefinitionArn:api.service.taskDefinition,containers:[{lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}];
 const taskDefinition={...connectWorkerRegistration(plan,now),taskDefinitionArn:arn('existing-worker',4)};
 const worker={observedAt:at,service:{...snapshot.worker.service,taskDefinition:taskDefinition.taskDefinitionArn},taskDefinition,
  tasks:[{clusterArn:cluster,taskDefinitionArn:taskDefinition.taskDefinitionArn,lastStatus:'RUNNING',containers:[{name:'worker',lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}]};
 const portal={commit:source,indexSha256:'f'.repeat(64),apiUrl:'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws',
  approvalPath:'/app/records/connect/approve',capabilities:{connectApproval:1,orderWorkspaceApproval:1}};
 const input={enabled:true,plan,apiObservation:api,workerObservation:worker,portalManifest:portal};
 const request=connectWorkspaceSwitch(input,now);
 assert.equal(request.serviceArn,TARGET.serviceArn);
 assert.deepEqual(request.primaryContainer.environment.slice(0,-1),plan.apiUpdate.primaryContainer.environment);
 assert.deepEqual(request.primaryContainer.environment.at(-1),{name:'PACKPROOF_ORDER_WORKSPACE_ENABLED',value:'true'});
 assert.deepEqual(request.primaryContainer.secrets,plan.apiUpdate.primaryContainer.secrets);
 assert.throws(()=>connectWorkspaceSwitch({...input,portalManifest:{...portal,commit:old}},now),/PORTAL_REQUIRED/);
 assert.throws(()=>connectWorkspaceSwitch({...input,workerObservation:{...worker,tasks:[]}},now),/WORKER_DIGEST/);
 assert.throws(()=>connectWorkspaceSwitch({...input,apiObservation:{...api,tasks:[]}},now),/API_TASK_DIGEST/);
 assert.equal(connectWorkspaceSwitch({...input,enabled:false,workerObservation:undefined,portalManifest:undefined},now).primaryContainer.environment.at(-1).value,'false');
 // Recovery can occur after the forward-deployment review has expired. Both actual bridge
 // readers must be freshly rerun, and the API must be stably disabled before image reversal.
 const later=now+3*3600000,observedAt=new Date(later).toISOString(),readers={};
 for(const [index,kind] of ['api','worker'].entries()){
  const original=structuredClone(probes['previous-'+kind]);
  const request=connectRecoveryProbe({plan,kind,registered:original.registered,snapshot:{...snapshot,observedAt},attempt:'recovery-1'},later);
  assert.equal(request.taskDefinition,original.registered.taskDefinitionArn);
  const actual=cluster.replace(':cluster/',':task/')+'/'+String(index+7).repeat(32);
  original.report.taskArn=actual;original.report.completedAt=observedAt;original.task.taskArn=actual;
  readers[kind]=original;
 }
 const recoveryInput={plan,readers,apiObservation:{...api,topology:snapshot.topology,observedAt},workerObservation:{...worker,observedAt}};
 assert.deepEqual(connectRecoveryUpdate({...recoveryInput,kind:'api'},later).primaryContainer,snapshot.api.express.activeConfigurations[0].primaryContainer);
 const active=structuredClone(recoveryInput);active.apiObservation.express.activeConfigurations[0].primaryContainer=request.primaryContainer;
 assert.throws(()=>connectRecoveryUpdate({...active,kind:'api'},later),/WORKSPACE_ACTIVE/);
 const stale=structuredClone(recoveryInput);stale.readers.api=probes['previous-api'];
 assert.throws(()=>connectRecoveryUpdate({...stale,kind:'api'},later),/FRESH_READER/);
 const compromised=structuredClone(recoveryInput);compromised.readers.worker.task.overrides={containerOverrides:[{name:'worker',command:['bash']}]};
 assert.throws(()=>connectRecoveryUpdate({...compromised,kind:'api'},later),/STOPPED_TASK/);
 assert.throws(()=>connectRecoveryUpdate({...recoveryInput,kind:'worker'},later),/API_CHANGED/);
 const stableBridge={...snapshot.api,observedAt,meta:{commit:source,image:previous},topology:snapshot.topology,
  tasks:[{lastStatus:'RUNNING',taskDefinitionArn:api.service.taskDefinition,containers:[{lastStatus:'RUNNING',imageDigest:previous.split('@')[1]}]}]};
 assert.equal(connectRecoveryUpdate({...recoveryInput,kind:'worker',apiObservation:stableBridge},later).taskDefinition,snapshot.worker.service.taskDefinition);
 assert.deepEqual(definitions.api.containerDefinitions[0].command,['node','/release/reconstruction-v11-hosted-runtime-preflight.mjs','api']);
 const changed=structuredClone(probes);changed['previous-worker'].report.schema='packproof.order-workspace-rollback-reader/v1';
 assert.throws(()=>connectRuntimePlan(snapshot,review,changed,now,code),/COMPATIBLE_PREDECESSOR/);
 const bridge=connectRuntimeBuildRequest({profile:'collector-hosted-bridge',sourceTransport:'git-commit',sourceSha:source,archiveSha256:'a'.repeat(64),predecessorImages:[previous]});
 for(const needle of ['reconstruction-v11 --verify','Dockerfile.collector-hosted-bridge','COLLECTOR_BRIDGE_GUARD','124_connect_collector_version'])assert.ok(bridge.buildspecOverride.includes(needle));
});

test('compares ECS environment bindings by unique name without normalizing other fields or the provider response',()=>{
 const f=fixture(),actual=structuredClone(f.probes.api.registered);
 const original=connectProbeRunRequest(f.snapshot,f.review,'api',actual,script,now);
 const originalPlan=connectRuntimePlan(f.snapshot,f.review,f.probes,now,script);
 const lease=connectConfigurationLease(f.snapshot);
 actual.containerDefinitions[0].environment.reverse();
 const raw=JSON.stringify(actual);
 assert.deepEqual(connectProbeRunRequest(f.snapshot,f.review,'api',actual,script,now),original);
 assert.equal(JSON.stringify(actual),raw);
 f.probes.api.registered=actual;
 assert.deepEqual(connectRuntimePlan(f.snapshot,f.review,f.probes,now,script),originalPlan);
 assert.equal(connectConfigurationLease(f.snapshot),lease);
 for(const change of [
  t=>{t.containerDefinitions[0].environment[0].value+='-changed';},
  t=>{t.containerDefinitions[0].environment.pop();},
  t=>{t.containerDefinitions[0].environment[0].name+='-changed';},
  t=>{t.containerDefinitions[0].environment.push({...t.containerDefinitions[0].environment[0]});},
  t=>{t.containerDefinitions[0].environment[0].value=7;},
  t=>{t.containerDefinitions[0].environment[0].name='';},
  t=>{t.containerDefinitions[0].command.reverse();},
  t=>{t.containerDefinitions[0].secrets[0].valueFrom+='-changed';},
  t=>{t.containerDefinitions[0].dockerLabels={'test-header':'changed'};},
  t=>{t.executionRoleArn+='-changed';}
 ]){
  const changed=structuredClone(actual);
  change(changed);
  assert.throws(()=>connectProbeRunRequest(f.snapshot,f.review,'api',changed,script,now),
   /PROBE_REGISTRATION_MISMATCH|BINDINGS_AMBIGUOUS/);
 }
 const plan=originalPlan;
 const registered={...structuredClone(plan.workerRegister),taskDefinitionArn:arn(plan.workerRegister.family,3)};
 const observation={...f.snapshot.worker,observedAt:at};
 const first=connectWorkerUpdate(plan,registered,observation,now);
 registered.containerDefinitions[0].environment.reverse();
 assert.deepEqual(connectWorkerUpdate(plan,registered,observation,now),first);
});
