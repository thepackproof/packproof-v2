import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {prepareLogisticsImages} from './logistics-image-builds.mjs';
import {hash} from './backend-deployment-plan.mjs';
import {hostedLockPolicySha256} from './hosted-membership-locks.mjs';
import {logisticsTarget as T,logisticsLedgers,logisticsDigest,logisticsBindingDigest,verifyLogisticsInventories,
  validateLogisticsProbe,verifyLogisticsRuntime,formatLogisticsProbeFailure} from './logistics-runtime-preflight.mjs';
import {normalizeLogisticsSnapshot,verifyLogisticsRelease,createLogisticsRuntimeReview,logisticsProbeReview,
  logisticsProbeRegistrations,logisticsProbeRunRequest,collectLogisticsProbeReceipt,createLogisticsRuntimePlan,
  logisticsWorkerRegistration,logisticsWorkerUpdate,logisticsApiUpdate,logisticsRecoveryApiUpdate,
  logisticsRecoveryWorkerUpdate} from './logistics-runtime-release.mjs';

// Synthetic control-plane and receipt fixtures. Never release evidence.
const now=Date.parse('2026-11-21T22:57:00Z'),at=new Date(now).toISOString(),source='b'.repeat(40),old='a'.repeat(40);
const image=d=>T.repository+'@sha256:'+d.repeat(64),previous=image('a'),candidate=image('b'),fallback=image('c');
const arn=(family,n=1)=>`arn:aws:ecs:${T.region}:${T.account}:task-definition/${family}:${n}`;
const taskArn=n=>T.clusterArn.replace(':cluster/',':task/')+'/'+n.repeat(32);
const serviceArn=kind=>T.clusterArn.replace(':cluster/',':service/')+'/'+(kind==='api'?'packproof-v2-staging-api':'packproof-records-worker');
const e=c=>Object.fromEntries(c.environment.map(v=>[v.name,v.value]));
function locks(role){return {schema:'packproof.hosted-platform-lock-observation/v1',role,policySha256:hostedLockPolicySha256,
  membership:{selectTable:true,updateTable:false,updateColumns:['revoked_at'],grantableUpdate:false,idMutable:false,
    triggerSha256:'85290fcfa99548c8c15bac587a335bfb30fa35589a76776b63390225fbe63dd6',
    functionSha256:'981746c709450f6ee117421020f623cfedb9a60591176037df75d12b9b30f774',bodySha256:'cf116d09c6fb507a38a9f4cfa7cb74a897ee31e0cf4184ef1ec5c13425cf2bf7'},
  proof:{idUpdate:true,idUpdateGrantable:false},membershipLock:{mode:'EXPLAIN WITHOUT ANALYZE',authorized:true,plan:'LockRows/Result/false',
    readOnlyTransaction:true,statementExecuted:false},grantsApplied:false};}
function observation(kind,current,sha) {
  const main={name:kind,image:current,essential:true,readonlyRootFilesystem:true,
    environment:Object.entries({PACKPROOF_PROCESS_ROLE:kind,PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',
      PACKPROOF_RELEASE_SHA:sha,PACKPROOF_RELEASE_IMAGE:current,PACKPROOF_RELEASE_VERSION:'0.7.0',PACKPROOF_DB_HOST:T.host,
      PACKPROOF_DB_NAME:T.database,PACKPROOF_WEB_ORIGINS:'https://thepackproof.com',PACKPROOF_PUBLIC_URL:'https://existing.invalid',
      PACKPROOF_TRUSTED_PROXIES:'10.0.0.0/16',...(kind==='api'?{PACKPROOF_ORDER_WORKSPACE_ENABLED:'true'}:{})}).map(([name,value])=>({name,value})),
    secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:`arn:aws:secretsmanager:${T.region}:${T.account}:secret:runtime-${kind}`}],
    logConfiguration:{logDriver:'awslogs',options:{'awslogs-group':'/ecs/packproof-v2-staging-api','awslogs-region':T.region,'awslogs-stream-prefix':kind}},
    command:['node','dist/index.js']};
  const init={name:'temporary-volume-init',image:current,essential:false,user:'0',entryPoint:['/bin/sh','-c'],
    command:['chmod 1777 /tmp/work'],mountPoints:[{sourceVolume:'tmp',containerPath:'/tmp/work'}]};
  if(kind==='worker'){main.dependsOn=[{containerName:init.name,condition:'SUCCESS'}];main.mountPoints=structuredClone(init.mountPoints);}
  const td={family:'existing-'+kind,taskDefinitionArn:arn('existing-'+kind),status:'ACTIVE',revision:1,
    networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],taskRoleArn:`arn:aws:iam::${T.account}:role/runtime-${kind}`,
    executionRoleArn:`arn:aws:iam::${T.account}:role/execute`,cpu:'1024',memory:'2048',
    containerDefinitions:kind==='worker'?[main,init]:[main],...(kind==='worker'?{volumes:[{name:'tmp',host:{}}]}:{})};
  const networkConfiguration={awsvpcConfiguration:{subnets:['subnet-1234'],securityGroups:['sg-abcd'],assignPublicIp:'ENABLED'}};
  const service={serviceArn:serviceArn(kind),clusterArn:T.clusterArn,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,
    taskDefinition:td.taskDefinitionArn,launchType:'FARGATE',platformVersion:'1.4.0',networkConfiguration,
    deploymentConfiguration:{minimumHealthyPercent:100,maximumPercent:200},
    deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:td.taskDefinitionArn}]};
  const tasks=[{taskArn:taskArn(kind==='api'?'1':'2'),clusterArn:T.clusterArn,group:'service:'+(kind==='api'?'packproof-v2-staging-api':'packproof-records-worker'),
    taskDefinitionArn:td.taskDefinitionArn,lastStatus:'RUNNING',desiredStatus:'RUNNING',healthStatus:'HEALTHY',
    containers:td.containerDefinitions.map(c=>({name:c.name,imageDigest:current.split('@')[1],
      lastStatus:c===main?'RUNNING':'STOPPED',...(c===main?{}:{exitCode:0})}))}];
  const out={observedAt:at,service,taskDefinition:td,tasks};
  if(kind==='api'){
    const revision={serviceRevisionArn:'revision-1',serviceArn:service.serviceArn,taskDefinition:td.taskDefinitionArn,
      launchType:'FARGATE',platformVersion:'1.4.0',networkConfiguration};
    out.revision=revision;out.express={serviceArn:service.serviceArn,activeConfigurations:[{serviceRevisionArn:revision.serviceRevisionArn,primaryContainer:structuredClone(main)}]};
    out.nativeDeployment={targetServiceRevision:{arn:revision.serviceRevisionArn},status:'SUCCESSFUL'};
    out.nativeDeploymentStatus='SUCCESSFUL';out.meta={commit:sha,image:current,version:'0.7.0'};
    out.publicChecks={'/health':200,'/ready':200,'/me/capabilities':401};
  }
  return out;
}
function fixture(profile='fallback') {
  const current=profile==='fallback'?previous:profile==='candidate'?fallback:candidate,sha=profile==='fallback'?old:source;
  const api=observation('api',current,sha),worker=observation('worker',current,sha);
  const topology={trustedProxies:{configured:true,value:'10.0.0.0/16'},loadBalancers:[{id:'alb'}],targetGroups:[{id:'tg'}],securityGroups:[{id:'sg'}],subnets:[{id:'subnet'}]};
  api.topology=topology;
  const snapshot={account:T.account,region:T.region,observedAt:at,api,worker,topology,
    probe:{clusterArn:T.clusterArn,networkConfiguration:structuredClone(worker.service.networkConfiguration),platformVersion:'1.4.0'}};
  const archiveSha256='d'.repeat(64),sourceVersion='version-123',built=prepareLogisticsImages({source,archiveSha256,sourceVersion,predecessorImage:previous});
  const detail=(tag,img)=>({registryId:T.account,repositoryName:'packproof-v2-staging-api',imageTags:[tag],imageDigest:img.split('@')[1]});
  const candidateDetail=detail(built.receipt.candidateTag,candidate),fallbackDetail=detail(built.receipt.fallbackTag,fallback);
  const release={images:built.receipt,archiveSha256,sourceVersion,ci:{id:123,repository:{full_name:'thepackproof/packproof-v2'},name:'CI',path:'.github/workflows/ci.yml',head_sha:source,head_branch:'main',event:'push',status:'completed',conclusion:'success'},
    candidate:{imageDetails:[candidateDetail]},fallback:{imageDetails:[fallbackDetail]},build:{id:'packproof-v2-staging-api:build',projectName:'packproof-v2-staging-api',buildStatus:'SUCCEEDED',buildComplete:true,sourceVersion,
      source:{type:'S3',location:built.request.sourceLocationOverride,buildspec:built.request.buildspecOverride},environment:{environmentVariables:built.request.environmentVariablesOverride},logs:{groupName:'build-group',streamName:'build-stream'}},
    buildLog:{group:'build-group',stream:'build-stream',events:[{message:JSON.stringify({imageDetails:[candidateDetail,fallbackDetail]},null,2)},{message:JSON.stringify(built.receipt)}]}};
  const review=createLogisticsRuntimeReview({snapshot,release,profile,expiresAt:new Date(now+110*60000).toISOString()},now);
  return {snapshot,release,review};
}
function receipt(f,label,index) {
  const [side,kind]=label.split('-'),p=logisticsProbeReview(f.snapshot,f.review,side,kind),definitions=logisticsProbeRegistrations(f.snapshot,f.review,now);
  const td={...definitions[label],taskDefinitionArn:arn(definitions[label].family),status:'ACTIVE',revision:1};
  const role=kind==='api'?T.apiRole:T.workerRole;
  const report={schema:'packproof.logistics-runtime-probe/v1',reviewSha256:logisticsBindingDigest(p),source:p.source,kind,side,profile:p.profile,
    taskIdentity:{taskArn:taskArn(String(index)),image:p.image,imageDigest:p.image.split('@')[1]},ledgerThrough:p.ledgerThrough,sourceThrough:p.sourceThrough,
    fullPrivileges:p.fullPrivileges,environmentSha256:p.environmentSha256,readOnly:true,featureActivation:false,completedAt:at,
    identity:{role,login:role,database:T.database,schema:'public',read_only:'on'},tls:{ssl:true},
    schemaReaderVerified:true,immutableTriggerVerified:true,backfillScopeVerified:true,orderHistoryGuardsVerified:true,
    legacyReaderVerified:true,legacyReaderKind:kind==='api'?'order-history':'worker-imports',workerOrderHistoryDenied:kind==='worker'?true:null,
    durabilityPolicyMatches:true,compiledCollectorVerified:true,platformLocks:locks(role),m2PrivilegesSha256:'f'.repeat(64),
    inventory:{sourceCount:logisticsLedgers[p.sourceThrough].count,appliedCount:logisticsLedgers[p.ledgerThrough].count,
      sourceSha256:logisticsLedgers[p.sourceThrough].sha256,inventorySha256:logisticsLedgers[p.ledgerThrough].sha256,migrationsApplied:false,rolesChanged:false},
    recordsPrivileges:p.fullPrivileges?{schema:'packproof.records-runtime-privileges/v1',sourceCommit:p.source,databaseSchema:'public',caller:role,
      runtimeRole:T.apiRole,workerRole:T.workerRole,migrationSha256:'d'.repeat(64),policySha256:'e'.repeat(64),effectivePrivilegesSha256:'f'.repeat(64)}:null,
    automationPolicy:{schema:'packproof.shipment-policy-role/v1',kind,bundleSha256:'d'.repeat(64),interpretationVersion:'packproof.shipment-interpretation/v1',
      headerPolicyVersion:'same_names_any_order/v1',interpretationEnabled:false,headerVariantsEnabled:false,workerInterpretation:null,workerHeaderPolicy:null,
      shadowSourcesSha256:logisticsDigest([]),shadowSourceCount:0},recoveryQuiescence:p.profile==='recovery'?{active_sources:0,pending_batches:0,pending_projections:0}:null};
  const task={taskArn:report.taskIdentity.taskArn,clusterArn:T.clusterArn,taskDefinitionArn:td.taskDefinitionArn,lastStatus:'STOPPED',
    overrides:{containerOverrides:td.containerDefinitions.map(c=>({name:c.name})),inferenceAcceleratorOverrides:[]},
    containers:td.containerDefinitions.map(c=>({name:c.name,lastStatus:'STOPPED',exitCode:0,imageDigest:p.image.split('@')[1]}))};
  const primary=td.containerDefinitions.find(c=>e(c).PACKPROOF_PROCESS_ROLE===kind),options=primary.logConfiguration.options;
  return collectLogisticsProbeReceipt({taskDefinition:td,task,logGroup:options['awslogs-group'],
    logStream:options['awslogs-stream-prefix']+'/'+primary.name+'/'+task.taskArn.split('/').at(-1),events:[{message:JSON.stringify(report)}]});
}
function qualified(profile='fallback') {const f=fixture(profile);f.probes=Object.fromEntries(['target-api','target-worker','peer-api','peer-worker'].map((k,i)=>[k,receipt(f,k,i+3)]));return f;}
const plan=f=>createLogisticsRuntimePlan(f,now);
function promoted(f,p,kind) {
  const result=observation(kind,p.image,p.source);
  if(kind==='worker') {
    result.taskDefinition={...structuredClone(p.workerRegister),taskDefinitionArn:arn(p.workerRegister.family,2),revision:2,status:'ACTIVE'};
    result.service.taskDefinition=result.taskDefinition.taskDefinitionArn;
    result.service.deployments[0].taskDefinition=result.taskDefinition.taskDefinitionArn;
    result.tasks[0].taskDefinitionArn=result.taskDefinition.taskDefinitionArn;
  } else {
    const actual=p.apiUpdate?.primaryContainer??p.rollbackApi.primaryContainer;
    result.express.activeConfigurations[0].primaryContainer=structuredClone(actual);result.topology=f.snapshot.topology;
    result.meta.version=e(actual).PACKPROOF_RELEASE_VERSION;
    result.taskDefinition.containerDefinitions[0].environment=structuredClone(actual.environment);
  }
  return result;
}

test('four independent actual-login receipts admit fallback124 and candidate129 while preserving workspace, credentials and initializer',()=>{
  for(const profile of ['fallback','candidate']) {
    const f=qualified(profile),before=structuredClone(f.snapshot),p=plan(f);
    assert.deepEqual(f.snapshot,before);assert.equal(p.ledgerThrough,profile==='fallback'?124:129);
    assert.equal(e(p.apiUpdate.primaryContainer).PACKPROOF_ORDER_WORKSPACE_ENABLED,'true');
    assert.equal(e(p.workerRegister.containerDefinitions[0]).PACKPROOF_ORDER_WORKSPACE_ENABLED,undefined);
    assert.deepEqual(p.workerRegister.containerDefinitions[0].secrets,f.snapshot.worker.taskDefinition.containerDefinitions[0].secrets);
    assert.deepEqual(p.workerRegister.containerDefinitions[1],{...f.snapshot.worker.taskDefinition.containerDefinitions[1],image:p.image});
    const registered={...logisticsWorkerRegistration(p,now),status:'ACTIVE',taskDefinitionArn:arn(p.workerRegister.family,2)};
    assert.equal(logisticsWorkerUpdate({plan:p,registered,observation:f.snapshot.worker},now).taskDefinition,registered.taskDefinitionArn);
    assert.throws(()=>logisticsApiUpdate({plan:p,apiObservation:f.snapshot.api,workerObservation:f.snapshot.worker},now));
    const updated=promoted(f,p,'worker');assert.equal(logisticsApiUpdate({plan:p,apiObservation:f.snapshot.api,workerObservation:updated},now).primaryContainer.image,p.image);
  }
});
test('CANARY takes the sole active Express service revision, not a deployment-array guess',()=>{
  const f=fixture();delete f.snapshot.api.service.taskDefinition;f.snapshot.api.service.deployments[0].taskDefinition=arn('unrelated');
  assert.equal(normalizeLogisticsSnapshot(f.snapshot).api.service.taskDefinition,f.snapshot.api.revision.taskDefinition);
  for(const mutate of [x=>x.api.express.activeConfigurations.push(x.api.express.activeConfigurations[0]),x=>x.api.revision.serviceArn=serviceArn('worker'),
    x=>x.api.revision.serviceRevisionArn='other',x=>x.api.nativeDeployment.targetServiceRevision.arn='other']){
    const s=structuredClone(f.snapshot);mutate(s);assert.throws(()=>normalizeLogisticsSnapshot(s));
  }
});
test('source build, actual publication logs and live ECR must bind to identical immutable images',()=>{
  const f=fixture();assert.equal(verifyLogisticsRelease(f.release).candidate,candidate);
  for(const mutate of [r=>r.candidate.imageDetails[0].imageDigest='sha256:'+'e'.repeat(64),r=>r.ci.name='Connect Windows candidate',
    r=>r.build.sourceVersion='other',r=>r.build.source.buildspec+='\n',r=>r.buildLog.stream='other',
    r=>r.buildLog.events.push(r.buildLog.events[1]),r=>r.build.environment.environmentVariables[0].value=old]) {
    const r=structuredClone(f.release);mutate(r);assert.throws(()=>verifyLogisticsRelease(r));
  }
});
test('fail closed on forged probe outcomes, task overrides, stale receipts, altered commands and reused tasks',()=>{
  for(const mutate of [f=>f.probes['target-api'].task.overrides.taskRoleArn='other',
    f=>f.probes['target-worker'].task.overrides.containerOverrides[0].environment=[{name:'BYPASS',value:'true'}],
    f=>f.probes['target-api'].registered.containerDefinitions[0].command=['node','dist/index.js'],
    f=>f.probes['peer-worker'].task.containers[1].exitCode=1,
    f=>f.probes['target-api'].task.containers[0].imageDigest=previous.split('@')[1],
    f=>f.probes['target-worker'].report.identity.role=T.ownerRole,
    f=>f.probes['peer-api'].report.completedAt=new Date(now+1).toISOString(),
    f=>f.probes['peer-api'].report.completedAt=new Date(now-900001).toISOString(),
    f=>f.probes['peer-api'].report.taskIdentity.taskArn=f.probes['target-api'].task.taskArn,
    f=>f.probes['target-api'].log.stream='wrong-stream',
    f=>f.probes['target-api'].report.inventory.inventorySha256='0'.repeat(64),
    f=>f.probes['target-api'].report.recordsPrivileges.effectivePrivilegesSha256='0'.repeat(64),
    f=>delete f.probes['peer-worker']]) {
    const f=qualified();mutate(f);assert.throws(()=>plan(f));
  }
});
test('provider-only field defaults and environment order do not block a correctly registered worker after rollout',()=>{
  const f=qualified(),p=plan(f),worker=promoted(f,p,'worker');
  for(const c of worker.taskDefinition.containerDefinitions){c.cpu=0;c.systemControls=[];c.environment?.reverse();c.secrets?.reverse();}
  worker.taskDefinition.placementConstraints=[];worker.taskDefinition.enableFaultInjection=false;
  assert.equal(logisticsApiUpdate({plan:p,apiObservation:f.snapshot.api,workerObservation:worker},now).primaryContainer.image,p.image);
  worker.taskDefinition.containerDefinitions[1].command=['echo','changed'];
  assert.throws(()=>logisticsApiUpdate({plan:p,apiObservation:f.snapshot.api,workerObservation:worker},now));
});
test('feature, topology and runtime secret-reference changes invalidate the release lease',()=>{
  for(const mutate of [f=>f.snapshot.worker.taskDefinition.containerDefinitions[0].secrets[0].valueFrom+='-changed',
    f=>f.snapshot.topology.securityGroups.push({id:'new'}),f=>f.snapshot.api.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_GUIDED_FACILITIES',value:'*'}),
    f=>f.snapshot.api.taskDefinition.containerDefinitions[0].environment.push({name:'PACKPROOF_SETUP_AI_FACILITIES',value:'org:live:site'}),
    f=>f.snapshot.observedAt=new Date(now-900001).toISOString()]) {
    const f=qualified();mutate(f);assert.throws(()=>plan(f));
  }
});
test('probe definitions and retry requests retain credentials and forbid an unobserved alternate command',()=>{
  const f=fixture(),defs=logisticsProbeRegistrations(f.snapshot,f.review,now),d=defs['target-worker'];
  const main=d.containerDefinitions[0],binding=main.environment.find(x=>x.name==='PACKPROOF_LOGISTICS_PROBE_REVIEW');
  const decoded=JSON.parse(gunzipSync(Buffer.from(binding.value,'base64')));
  assert.equal(decoded.environmentSha256,logisticsProbeReview(f.snapshot,f.review,'target','worker').environmentSha256);
  const program=main.environment.find(x=>x.name==='PACKPROOF_LOGISTICS_PROBE_CODE');
  assert.equal(gunzipSync(Buffer.from(program.value,'base64')).toString('utf8'),readFileSync(new URL('./logistics-runtime-preflight.mjs',import.meta.url),'utf8'));
  assert.ok(main.command.at(-1).includes(f.review.probeCodeSha256));
  assert.ok(Buffer.byteLength(JSON.stringify(main.command))<8192);
  const registered={...d,status:'ACTIVE',taskDefinitionArn:arn(d.family)};
  const request=logisticsProbeRunRequest({...f,label:'target-worker',registered},now);
  assert.equal(request.enableExecuteCommand,false);assert.equal(request.overrides,undefined);
  assert.throws(()=>logisticsProbeRunRequest({...f,label:'target-worker',registered,retryOf:{taskArn:taskArn('a'),clusterArn:T.clusterArn,
    taskDefinitionArn:registered.taskDefinitionArn,lastStatus:'RUNNING'}},now));
});
test('recovery requires zero admitted unified work, reverses API first, and requires new evidence after API rollback',()=>{
  const f=qualified('recovery'),p=plan(f),registered={...p.workerRegister,status:'ACTIVE',taskDefinitionArn:arn(p.workerRegister.family,2)};
  assert.equal(logisticsRecoveryApiUpdate({plan:p,apiObservation:f.snapshot.api,workerObservation:f.snapshot.worker},now).primaryContainer.image,fallback);
  assert.throws(()=>logisticsRecoveryWorkerUpdate({plan:p,registered,apiObservation:promoted(f,p,'api'),workerObservation:f.snapshot.worker},now),/REFRESH_AFTER_API/);
  const unsafe=qualified('recovery');unsafe.probes['target-api'].report.recoveryQuiescence.pending_batches=1;assert.throws(()=>plan(unsafe),/RECOVERY_WORK/);
  const refreshed=fixture('recovery');refreshed.snapshot.api=promoted(f,p,'api');
  refreshed.review=createLogisticsRuntimeReview({snapshot:refreshed.snapshot,release:refreshed.release,profile:'recovery',expiresAt:f.review.expiresAt},now);
  refreshed.probes=Object.fromEntries(['target-api','target-worker','peer-api','peer-worker'].map((k,i)=>[k,receipt(refreshed,k,i+3)]));
  const next=plan(refreshed),newTd={...next.workerRegister,status:'ACTIVE',taskDefinitionArn:arn(next.workerRegister.family,3)};
  assert.equal(logisticsRecoveryWorkerUpdate({plan:next,registered:newTd,apiObservation:refreshed.snapshot.api,workerObservation:refreshed.snapshot.worker},now).taskDefinition,newTd.taskDefinitionArn);
  assert.throws(()=>createLogisticsRuntimeReview({snapshot:fixture().snapshot,release:f.release,profile:'recovery',expiresAt:f.review.expiresAt},now));
});

const directory=new URL('../../backend/migrations/',import.meta.url);
const inventory=()=>readdirSync(directory).filter(x=>x.endsWith('.sql')).sort().map(name=>{const sql=readFileSync(new URL(name,directory),'utf8');return{id:name.slice(0,-4),checksum:logisticsDigest(sql),sql};});
test('frozen SQL inventory and exact129 backfill trigger distinguish compatible fallback from unreviewed schema',()=>{
  const rows=inventory(),before=rows.slice(0,123);
  assert.equal(verifyLogisticsInventories(rows,rows,{sourceThrough:129,ledgerThrough:129}).inventorySha256,logisticsLedgers[129].sha256);
  assert.equal(verifyLogisticsInventories(before,rows,{sourceThrough:124,ledgerThrough:129}).sourceSha256,logisticsLedgers[124].sha256);
  assert.notEqual(hash(rows.map(({id,checksum})=>({id,checksum}))),logisticsLedgers[129].sha256,'canonical configuration hash is not migration protocol hash');
  assert.equal(logisticsDigest(rows.at(-1).sql.match(/LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/)[1]),logisticsLedgers[129].backfillBody);
  const altered=structuredClone(rows);altered.at(-1).checksum='0'.repeat(64);
  assert.throws(()=>verifyLogisticsInventories(rows,altered,{sourceThrough:129,ledgerThrough:129}),/APPLIED_INVENTORY/);
  assert.throws(()=>verifyLogisticsInventories(rows,rows.concat({id:'130_unreviewed',checksum:'0'.repeat(64)}),{sourceThrough:129,ledgerThrough:129}));
  const f=fixture('candidate'),r=logisticsProbeReview(f.snapshot,f.review,'target','api'),values={...e(f.snapshot.api.taskDefinition.containerDefinitions[0]),PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:candidate};
  assert.equal(validateLogisticsProbe(r,values,now),T.apiRole);
  assert.throws(()=>validateLogisticsProbe({...r,ledgerThrough:124},values,now),/REVIEW/);
});
test('runtime transaction rejects owner identity and missing TLS before any further database qualification',async()=>{
  const f=fixture('candidate'),r=logisticsProbeReview(f.snapshot,f.review,'target','api');
  for(const identity of [{role:T.ownerRole,login:T.ownerRole,database:T.database,schema:'public',read_only:'on',version:160000},
    {role:T.apiRole,login:T.apiRole,database:T.database,schema:'public',read_only:'on',version:160000}]) {
    const queries=[],db={query:async sql=>{queries.push(sql);return {rows:sql.includes('current_user')?[identity]:sql.includes('pg_stat_ssl')?[{ssl:false}]:[]};}};
    await assert.rejects(verifyLogisticsRuntime(db,r,{}),/ACTUAL_LOGIN_TLS/);
    assert.ok(queries.every(sql=>/^(SET|SELECT) /.test(sql)));
  }
});
test('worker imports remain readable without granting order-history SELECT, and unsafe worker authority fails',async()=>{
  const f=fixture(),r=logisticsProbeReview(f.snapshot,f.review,'target','worker'),rows=inventory().slice(0,123);
  const body=rows.find(row=>row.id==='124_connect_collector_version').sql.match(/LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/)[1];
  function dependencies(){return {migrationInventory:async()=>rows,assertSchemaCurrent:async()=>{},verifyShipmentInterpretationGuard:async()=>{},
    verifyOrderHistoryGuards:async()=>{},verifyHostedMembershipLocks:async()=>locks(T.workerRole),verifyM2RuntimePrivileges:async()=>({}),
    recordsMigrationInventory:async()=>({migrationSha256:'d'.repeat(64)}),
    verifyRecordsRuntimePrivileges:async()=>({caller:T.workerRole,sourceCommit:r.source}),requireDurableReceipts:false};}
  function database(allowed=false){const queries=[];return {queries,query:async sql=>{queries.push(sql);
    if(sql.startsWith('SET '))return {rows:[]};
    if(sql.includes('current_user AS role'))return {rows:[{role:T.workerRole,login:T.workerRole,database:T.database,schema:'public',read_only:'on',version:160000}]};
    if(sql.includes('pg_stat_ssl'))return {rows:[{ssl:true,version:'TLSv1.3'}]};
    if(sql==='SELECT id,checksum FROM schema_migrations ORDER BY id')return {rows:rows.map(({id,checksum})=>({id,checksum}))};
    if(sql.includes('AS unsafe'))return {rows:[{unsafe:false}]};
    if(sql.includes('p.prosrc'))return {rows:[['record_source_backfill_jobs','record_source_backfill_job_scope'],
      ['record_source_backfill_decisions','record_source_backfill_decision_scope'],['record_source_backfill_receipts','record_source_backfill_receipt_scope']].map(([relname,tgname])=>
      ({relname,tgname,tgenabled:'O',tgtype:7,tgnargs:0,unconditional:true,columns:'',prosrc:body,prosecdef:false,default_settings:true,lanname:'plpgsql',table_owner:true}))};
    if(sql.includes('has_any_column_privilege'))return {rows:[{allowed}]};
    if(/FROM record_order_(?:revisions|receipts) LIMIT/.test(sql))throw Object.assign(new Error('permission denied for API-only history'),{code:'42501'});
    if(sql.includes('FROM record_typed_batches LIMIT'))return {rows:[{first:0,second:0}]};
    if(sql.includes('FROM policy_recovery_fence'))return {rows:[{durability_required:false}]};
    throw Error('Unexpected query in worker regression fixture');
  }};}
  const db=database(),report=await verifyLogisticsRuntime(db,r,dependencies());
  assert.equal(report.legacyReaderKind,'worker-imports');assert.equal(report.workerOrderHistoryDenied,true);
  assert.ok(db.queries.some(sql=>sql.includes('FROM record_typed_batches LIMIT')));
  assert.ok(!db.queries.some(sql=>/FROM record_order_(?:revisions|receipts) LIMIT/.test(sql)));
  await assert.rejects(verifyLogisticsRuntime(database(true),r,dependencies()),e=>{
    assert.deepEqual(formatLogisticsProbeFailure(e),{event:'logistics_runtime_probe_failed',schema:'packproof.logistics-runtime-probe-error/v1',
      stage:'WORKER_ORDER_AUTHORITY',code:'LOGISTICS_PROBE_WORKER_ORDER_HISTORY_AUTHORITY'});return true;
  });
  const blocked=database(),original=blocked.query;blocked.query=async sql=>{if(sql.includes('FROM record_typed_batches LIMIT'))throw Object.assign(new Error('secret postgres://credential@host SQL select'),{code:'42501'});return original(sql);};
  await assert.rejects(verifyLogisticsRuntime(blocked,r,dependencies()),e=>{
    const diagnostic=formatLogisticsProbeFailure(e);assert.equal(diagnostic.stage,'LEGACY_READ');assert.equal(diagnostic.sqlState,'42501');
    assert.equal(diagnostic.code,'POSTGRES_ERROR');assert.doesNotMatch(JSON.stringify(diagnostic),/credential|postgres:\/\/|select/i);return true;
  });
});
test('diagnostics expose only closed stage names, safe helper code families and SQLSTATE',()=>{
  for(const secret of ['password=SECRET','postgres://user:SECRET@db','SELECT private_column FROM private_table','connection failed for privatehost']) {
    const detail=formatLogisticsProbeFailure(Object.assign(new Error(secret),{code:'42501',logisticsStage:secret}),'DATABASE_CONNECT');
    assert.deepEqual(detail,{event:'logistics_runtime_probe_failed',schema:'packproof.logistics-runtime-probe-error/v1',stage:'DATABASE_CONNECT',code:'POSTGRES_ERROR',sqlState:'42501'});
  }
  assert.equal(formatLogisticsProbeFailure(new Error('RECORDS_EFFECTIVE_COLUMN_PRIVILEGES_MISMATCH'),'RECORDS_PRIVILEGES').code,'RECORDS_EFFECTIVE_COLUMN_PRIVILEGES_MISMATCH');
  assert.equal(formatLogisticsProbeFailure(new Error('Error with SECRET'),'unrecognized stage').stage,'LOAD_PROBE');
});
