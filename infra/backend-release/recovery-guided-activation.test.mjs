import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {releasePins} from './recovery-hosted-release.mjs';
import {encryptFacilityReceipt,decryptFacilityReceipt} from './logistics-facility-inspect.mjs';
import {guidedName,guidedInventory,guidedSelectionDigest,guidedScopeDigest,validateGuidedRequest,
  selectBoundGuidedFacility,createGuidedPlan,guidedUpdateRequest,verifyGuidedResult,guidedPreservationHash,
  guidedSessionPolicy,guidedPhaseRunId} from './recovery-guided-activation.mjs';
import {safeGuidedFailure,guidedAwsFailureCode,guidedToolingPaths,guidedApiReadyForObservation} from './recovery-guided-activation-runner.mjs';

const now=Date.parse('2026-11-24T01:00:00Z'),at=new Date(now).toISOString(),source='a'.repeat(40),tooling='d'.repeat(40);
const image=letter=>TARGET.repository+'@sha256:'+letter.repeat(64),candidate=image('b');
const cluster='arn:aws:ecs:'+TARGET.region+':'+TARGET.account+':cluster/'+TARGET.cluster;
const role=name=>'arn:aws:iam::'+TARGET.account+':role/'+name;
const taskArn=letter=>cluster.replace(':cluster/',':task/')+'/'+letter.repeat(32);
const tdArn=(family,n=1)=>'arn:aws:ecs:'+TARGET.region+':'+TARGET.account+':task-definition/'+family+':'+n;
const key=generateKeyPairSync('x25519'),publicKey=key.publicKey.export({type:'spki',format:'der'}).toString('base64');
const subjectSha256='7'.repeat(64);
const env=c=>Object.fromEntries(c.environment.map(x=>[x.name,x.value]));
function observation(kind) {
  const family=kind==='api'?'packproof-v2-staging-cluster-packproof-v2-staging-api':'packproof-records-production-worker';
  const values={PACKPROOF_PROCESS_ROLE:kind,PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',
    PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:candidate,PACKPROOF_RELEASE_VERSION:'setup-recovery-0.7.1',
    PACKPROOF_DB_HOST:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',PACKPROOF_DB_NAME:'packproof_v2',
    PACKPROOF_ORDER_WORKSPACE_ENABLED:'true',CUSTOM_SETTING:'KEEP_RAW_SETTING_PRIVATE'};
  const c={name:kind,image:candidate,essential:true,readonlyRootFilesystem:true,command:['node','dist/index.js'],
    environment:Object.entries(values).map(([name,value])=>({name,value})),
    secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'PRIVATE_EXISTING_SECRET_REFERENCE'}],
    logConfiguration:{logDriver:'awslogs',options:{'awslogs-region':TARGET.region,'awslogs-group':'/ecs/packproof-v2-staging-api','awslogs-stream-prefix':'ecs'}}};
  const td={family,taskDefinitionArn:tdArn(family),status:'ACTIVE',revision:1,networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],
    taskRoleArn:role('packproof-records-v1-'+kind),executionRoleArn:role('packproof-records-v1-'+kind+'-execution'),
    cpu:'1024',memory:'2048',containerDefinitions:[c],runtimePlatform:{cpuArchitecture:'X86_64'}};
  const serviceArn=cluster.replace(':cluster/',':service/')+'/'+(kind==='api'?TARGET.serviceName:'packproof-records-worker');
  const networkConfiguration={awsvpcConfiguration:{subnets:['subnet-123'],securityGroups:['sg-123'],assignPublicIp:'ENABLED'}};
  const service={serviceArn,clusterArn:cluster,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:td.taskDefinitionArn,
    launchType:'FARGATE',platformVersion:'1.4.0',networkConfiguration,deploymentConfiguration:{minimumHealthyPercent:100,maximumPercent:200},
    deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:td.taskDefinitionArn}]};
  const tasks=[{taskArn:taskArn(kind==='api'?'1':'2'),clusterArn:cluster,group:'service:'+(kind==='api'?TARGET.serviceName:'packproof-records-worker'),
    taskDefinitionArn:td.taskDefinitionArn,lastStatus:'RUNNING',desiredStatus:'RUNNING',healthStatus:'HEALTHY',
    containers:[{name:kind,imageDigest:candidate.split('@')[1],lastStatus:'RUNNING',healthStatus:'HEALTHY'}]}];
  const value={observedAt:at,service,taskDefinition:td,tasks};
  if(kind==='api')Object.assign(value,{express:{serviceArn,infrastructureRoleArn:role('packproof-v2-staging-infrastructure'),status:'ACTIVE',updatedAt:at,
    activeConfigurations:[{serviceRevisionArn:'revision-1',taskDefinitionArn:td.taskDefinitionArn,createdAt:at,primaryContainer:structuredClone(c),
      executionRoleArn:td.executionRoleArn,taskRoleArn:td.taskRoleArn,cpu:'1024',memory:'2048',networkConfiguration,healthCheckPath:'/health'}]},
    revision:{serviceArn,serviceRevisionArn:'revision-1',taskDefinition:td.taskDefinitionArn,networkConfiguration,launchType:'FARGATE',platformVersion:'1.4.0'},
    nativeDeployment:{status:'SUCCESSFUL',targetServiceRevision:{arn:'revision-1'}},nativeDeploymentStatus:'SUCCESSFUL',
    meta:{commit:source,image:candidate,version:values.PACKPROOF_RELEASE_VERSION},publicChecks:{'/health':200,'/ready':200,'/me/capabilities':401}});
  return value;
}
function fixture() {
  const snapshot={account:TARGET.account,region:TARGET.region,observedAt:at,api:observation('api'),worker:observation('worker'),
    topology:{trustedProxies:{configured:true,value:'10.0.0.0/16'},loadBalancers:[{id:'same'}],targetGroups:[{id:'same'}],securityGroups:[{id:'same'}],subnets:[{id:'same'}]},
    probe:{clusterArn:cluster,networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-123'],securityGroups:['sg-123'],assignPublicIp:'ENABLED'}}}};
  const publication={source,archiveSha256:'8'.repeat(64),sourceVersion:'exact-version',buildId:TARGET.serviceName+':12345678-1234-4234-8234-123456789abc',
    ciRunId:17,candidate,fallback:image('c'),predecessor:image('f')};
  const row={installation_id:'installation_TEST',organization_id:'organization_SECRET_EXAMPLE',environment:'sandbox',location_id:'location_SECRET_EXAMPLE',
    device_name:'UNPUBLISHED_DEVICE',actor_role:'ADMIN',organization_enabled:true,actor_location_allowed:true,location_exists:true,
    enrollment_acknowledged:true,renewal_pending:false,status:'setup',eligibleLocationsTruncated:false,totalEligibleLocations:1,
    eligibleLocations:[{id:'location_SECRET_EXAMPLE',name:'UNPUBLISHED_LOCATION',guidedSetupAvailable:false,assistantSetupAvailable:false}]};
  const report={schema:'packproof.logistics-facility-inspection/v1',readOnly:true,rolledBack:true,source,image:candidate,inventorySha256:guidedInventory,
    completedAt:at,actualTask:taskArn('3'),truncated:false,totalMatchingInstallations:1,installations:[row]};
  const request={schema:'packproof.guided-activation-request/v1',operation:'activate',source:tooling,build:publication,expected:releasePins(snapshot),
    facility:{subjectSha256,selectionSha256:guidedSelectionDigest(row,subjectSha256),scopeSha256:guidedScopeDigest(row),recipientPublicKeySpki:publicKey},
    expiresAt:new Date(now+3600000).toISOString()};
  return {snapshot,publication,row,report,request};
}
function setting(snapshot,name,value) {
  for(const c of [snapshot.api.express.activeConfigurations[0].primaryContainer,snapshot.api.taskDefinition.containerDefinitions[0]]) {
    c.environment=c.environment.filter(x=>x.name!==name);if(value!==undefined)c.environment.push({name,value});
  }
}
function completed(f,plan) {
  const s=structuredClone(f.snapshot),a=s.api,c=plan.update?.primaryContainer??a.express.activeConfigurations[0].primaryContainer;
  a.express.activeConfigurations[0].primaryContainer=structuredClone(c);
  a.taskDefinition.containerDefinitions[0].environment=structuredClone(c.environment);
  a.taskDefinition.taskDefinitionArn=tdArn(a.taskDefinition.family,2);a.taskDefinition.revision=2;
  a.service.taskDefinition=a.taskDefinition.taskDefinitionArn;a.tasks[0].taskDefinitionArn=a.taskDefinition.taskDefinitionArn;
  a.revision.taskDefinition=a.taskDefinition.taskDefinitionArn;a.revision.serviceRevisionArn='revision-2';
  a.express.activeConfigurations[0].serviceRevisionArn='revision-2';a.express.activeConfigurations[0].taskDefinitionArn=a.taskDefinition.taskDefinitionArn;
  a.nativeDeployment.targetServiceRevision.arn='revision-2';return s;
}

test('guided observation waits through the old-successful deployment and two active same-image configurations',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now),after=completed(f,plan);
  const express=structuredClone(after.api.express);
  express.activeConfigurations.unshift(f.snapshot.api.express.activeConfigurations[0]);
  assert.equal(express.activeConfigurations[0].primaryContainer.image,express.activeConfigurations[1].primaryContainer.image);
  assert.equal(guidedApiReadyForObservation({express,deployment:f.snapshot.api.nativeDeployment,
    primaryContainerSha256:plan.afterPrimaryContainerSha256}),false);
});
test('guided observation does not mistake the old stable configuration for the new same-image plan',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now);
  assert.equal(f.snapshot.api.express.activeConfigurations[0].primaryContainer.image,plan.update.primaryContainer.image);
  assert.equal(guidedApiReadyForObservation({express:f.snapshot.api.express,deployment:f.snapshot.api.nativeDeployment,
    primaryContainerSha256:plan.afterPrimaryContainerSha256}),false);
});
test('guided observation waits for successful deployment and the exact target revision',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now),after=completed(f,plan);
  for(const status of ['IN_PROGRESS','PENDING','ROLLBACK_SUCCESSFUL','ROLLBACK_FAILED','STOPPED']) {
    assert.equal(guidedApiReadyForObservation({express:after.api.express,
      deployment:{...after.api.nativeDeployment,status},primaryContainerSha256:plan.afterPrimaryContainerSha256}),false);
  }
  assert.equal(guidedApiReadyForObservation({express:after.api.express,deployment:f.snapshot.api.nativeDeployment,
    primaryContainerSha256:plan.afterPrimaryContainerSha256}),false);
});
test('guided observation admits the exact planned singleton only after its matching deployment succeeds',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now),after=completed(f,plan);
  assert.equal(guidedApiReadyForObservation({express:after.api.express,deployment:after.api.nativeDeployment,
    primaryContainerSha256:plan.afterPrimaryContainerSha256}),true);
  assert.equal(verifyGuidedResult(plan,after,f.request,f.publication,now).workerUnchanged,true);
});
test('guided observation refuses incomplete metadata, absent plan hashes and unplanned container changes',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now),after=completed(f,plan);
  const ready={express:after.api.express,deployment:after.api.nativeDeployment,primaryContainerSha256:plan.afterPrimaryContainerSha256};
  const mutations=[x=>delete x.express,x=>delete x.express.activeConfigurations,x=>x.express.activeConfigurations=[],
    x=>delete x.express.activeConfigurations[0].primaryContainer,x=>x.express.activeConfigurations[0].primaryContainer=null,
    x=>x.express.activeConfigurations[0].primaryContainer=[],x=>delete x.deployment,
    x=>delete x.deployment.targetServiceRevision,x=>x.deployment.targetServiceRevision.arn='',
    x=>delete x.primaryContainerSha256,x=>x.primaryContainerSha256='invalid',
    x=>x.express.activeConfigurations[0].primaryContainer.command=['other'],
    x=>x.express.activeConfigurations[0].primaryContainer.environment.push({name:'OTHER',value:'changed'})];
  for(const mutate of mutations){const x=structuredClone(ready);mutate(x);assert.equal(guidedApiReadyForObservation(x),false);}
});

test('digest-only request refuses raw identities, caller-selected settings, wrong build, noncandidate pins and expiration',()=>{
  validateGuidedRequest(fixture().request,now);
  const cases=[r=>r.facility.subject='11111111-2222-4333-8444-555555555555',r=>r.environment={PACKPROOF_GUIDED_FACILITIES:'*'},
    r=>r.facility.selectionSha256='Example workstation',r=>r.build.candidate=r.build.fallback,r=>r.expected.api.image=r.build.fallback,
    r=>r.build.sourceVersion='null',r=>r.expiresAt=at,r=>r.operation='run-sql',r=>r.facility.recipientPublicKeySpki='invalid'];
  for(const mutate of cases){const r=fixture().request;mutate(r);assert.throws(()=>validateGuidedRequest(r,now));}
});
test('only the exact already-bound installation, current administrator and active operator intersection can qualify',()=>{
  const f=fixture();assert.equal(selectBoundGuidedFacility(f.report,f.request,now).installation_id,f.row.installation_id);
  const mutations=[r=>r.location_id=null,r=>r.location_id='different',r=>r.organization_id='different',r=>r.environment='live',r=>r.actor_role='OPERATOR',
    r=>r.organization_enabled=false,r=>r.actor_location_allowed=false,r=>r.location_exists=false,r=>r.enrollment_acknowledged=false,
    r=>r.renewal_pending=true,r=>r.status='revoked',r=>r.status='paused',r=>r.eligibleLocations=[],r=>r.eligibleLocationsTruncated=true];
  for(const mutate of mutations){const x=fixture();mutate(x.row);assert.throws(()=>selectBoundGuidedFacility(x.report,x.request,now));}
  for(const mutate of [r=>r.inventorySha256='0'.repeat(64),r=>r.source=tooling,r=>r.image=image('c'),r=>r.rolledBack=false,
    r=>r.truncated=true,r=>r.installations.push(r.installations[0]),r=>r.completedAt=new Date(now-300001).toISOString()]) {
    const x=fixture();mutate(x.report);assert.throws(()=>selectBoundGuidedFacility(x.report,x.request,now));
  }
});
test('the one-setting plan preserves the original image/source, all other API configuration and the worker',()=>{
  const f=fixture();setting(f.snapshot,guidedName,'organization_OTHER:sandbox:location_OTHER');
  f.request.expected=releasePins(f.snapshot);const plan=createGuidedPlan(f,now);
  const c=plan.update.primaryContainer,original=f.snapshot.api.express.activeConfigurations[0].primaryContainer;
  assert.equal(c.image,original.image);assert.equal(env(c).PACKPROOF_RELEASE_SHA,source);assert.notEqual(source,tooling);
  assert.equal(env(c)[guidedName],'organization_OTHER:sandbox:location_OTHER,organization_SECRET_EXAMPLE:sandbox:location_SECRET_EXAMPLE');
  assert.deepEqual(c.secrets,original.secrets);assert.deepEqual(c.command,original.command);
  assert.deepEqual(guidedUpdateRequest(plan,f.snapshot,f.request,f.publication,now),plan.update);
  const after=completed(f,plan);assert.equal(guidedPreservationHash(after),guidedPreservationHash(f.snapshot));
  const result=verifyGuidedResult(plan,after,f.request,f.publication,now);
  assert.equal(result.workerUnchanged,true);assert.equal(result.assistantUnchanged,true);assert.equal(result.runtimeSource,source);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_EXAMPLE|UNPUBLISHED|KEEP_RAW_SETTING|PRIVATE_EXISTING|environment|primaryContainer/);
  assert.equal(result.rollback.previousApiTaskDefinition,f.snapshot.api.taskDefinition.taskDefinitionArn);
});
test('the route refuses disabled global admission, wildcards, ambiguous flags, indirect AI activation and config drift',()=>{
  for(const [name,value] of [['PACKPROOF_ORDER_WORKSPACE_ENABLED','false'],[guidedName,'*'],[guidedName,'one:sandbox:site,one:sandbox:site'],
    ['PACKPROOF_SETUP_AI_FACILITIES','organization_SECRET_EXAMPLE:sandbox:location_SECRET_EXAMPLE']]) {
    const f=fixture();setting(f.snapshot,name,value);f.request.expected=releasePins(f.snapshot);assert.throws(()=>createGuidedPlan(f,now));
  }
  const opaque=fixture();opaque.snapshot.api.taskDefinition.containerDefinitions[0].secrets.push({name:guidedName,valueFrom:'opaque'});
  assert.throws(()=>createGuidedPlan(opaque,now),/OPAQUE/);
  const f=fixture(),plan=createGuidedPlan(f,now);
  for(const mutate of [s=>s.worker.taskDefinition.cpu='2048',s=>s.api.express.infrastructureRoleArn=role('other'),s=>s.topology.subnets.push({id:'other'}),
    s=>setting(s,'CUSTOM_SETTING','changed'),s=>s.api.express.activeConfigurations[0].primaryContainer.image=image('c')]) {
    const s=structuredClone(f.snapshot);mutate(s);assert.throws(()=>guidedUpdateRequest(plan,s,f.request,f.publication,now));
  }
  const altered=structuredClone(plan);altered.update.primaryContainer.environment.push({name:'OTHER',value:'unsafe'});
  assert.throws(()=>guidedUpdateRequest(altered,f.snapshot,f.request,f.publication,now),/PLAN_CHANGED/);
  assert.throws(()=>guidedUpdateRequest(plan,f.snapshot,f.request,f.publication,now+300001),/PLAN_CHANGED_OR_EXPIRED/);
});
test('rollback removes only this recorded append and restores the exact previous setting on the same image',()=>{
  const f=fixture(),plan=createGuidedPlan(f,now),after=completed(f,plan),result=verifyGuidedResult(plan,after,f.request,f.publication,now);
  const r={...f.request,operation:'rollback',expected:releasePins(after),rollback:result.rollback};
  const reversed=createGuidedPlan({...f,snapshot:after,request:r,previousTaskDefinition:f.snapshot.api.taskDefinition},now);
  assert.equal(env(reversed.update.primaryContainer)[guidedName],undefined);
  assert.equal(reversed.update.primaryContainer.image,candidate);
  assert.deepEqual(reversed.update.primaryContainer,f.snapshot.api.express.activeConfigurations[0].primaryContainer);
  for(const mutate of [x=>x.request.rollback.activatedPrimaryContainerSha256='0'.repeat(64),
    x=>x.previousTaskDefinition.containerDefinitions[0].command=['other'],
    x=>x.previousTaskDefinition.containerDefinitions[0].environment.push({name:guidedName,value:'different:sandbox:site'})]) {
    const x={...f,snapshot:structuredClone(after),request:structuredClone(r),previousTaskDefinition:structuredClone(f.snapshot.api.taskDefinition)};
    mutate(x);assert.throws(()=>createGuidedPlan(x,now));
  }
});
test('existing exact guided scope is an observed no-op with no invented rollback material',()=>{
  const f=fixture();setting(f.snapshot,guidedName,'organization_SECRET_EXAMPLE:sandbox:location_SECRET_EXAMPLE');f.request.expected=releasePins(f.snapshot);
  const plan=createGuidedPlan(f,now);assert.equal(plan.changed,false);assert.equal(plan.update,null);
  assert.equal(verifyGuidedResult(plan,f.snapshot,f.request,f.publication,now).rollback,undefined);
});
test('ephemeral precheck authenticates encryption before scope selection and rejects tampering or a different recipient',()=>{
  const f=fixture(),ephemeral=generateKeyPairSync('x25519'),recipient=ephemeral.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const envelope=encryptFacilityReceipt(f.report,subjectSha256,recipient),privateKey=ephemeral.privateKey.export({type:'pkcs8',format:'pem'});
  const expected={source,image:candidate,inventorySha256:guidedInventory,actualTask:f.report.actualTask,subjectSha256};
  const report=decryptFacilityReceipt(envelope,privateKey,expected);assert.equal(selectBoundGuidedFacility(report,f.request,now).location_id,f.row.location_id);
  assert.doesNotMatch(JSON.stringify(envelope),/SECRET_EXAMPLE|UNPUBLISHED/);
  assert.throws(()=>decryptFacilityReceipt(envelope,key.privateKey.export({type:'pkcs8',format:'pem'}),expected));
  for(const field of ['ciphertext','tag','protected']) {const value=structuredClone(envelope);const bytes=Buffer.from(value[field],'base64');bytes[0]^=1;value[field]=bytes.toString('base64');assert.throws(()=>decryptFacilityReceipt(value,privateKey,expected));}
});
test('phase sessions retain exact runtime roles and isolate API mutation from fixed inspection task launches',()=>{
  const f=fixture();
  for(const phase of ['observe','precheck','apply','postcheck']) {
    const policy=guidedSessionPolicy(phase,{source,snapshot:f.snapshot,runId:'45286490363'});
    assert.ok(Buffer.byteLength(policy)<=2048,phase);assert.doesNotMatch(policy,/GetSecretValue|PutRolePolicy|CreateRole|UpdateService"|records-v1-worker/);
    if(phase==='apply'){assert.match(policy,/UpdateExpressGatewayService/);assert.doesNotMatch(policy,/RunTask|logs:/);}
    else assert.doesNotMatch(policy,/UpdateExpressGatewayService/);
  }
  assert.notEqual(guidedPhaseRunId('45286490363','precheck'),guidedPhaseRunId('45286490363','postcheck'));
  assert.throws(()=>guidedPhaseRunId('not-a-run','precheck'));
});
test('public workflow binds qualified source inputs and publishes only explicit receipts; failures omit raw diagnostics',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/connect-guided-activation.yml',import.meta.url),'utf8');
  assert.match(workflow,/paths: \['infra\/connect-rollout\/guided-promotion\.json'\]/);
  assert.match(workflow,/EXACT_TOOLING_AND_RUNTIME_MAIN_CI_REQUIRED/);assert.match(workflow,/verifyRuntimeInputs\(process.cwd\(\),request.build.source,request.source,request.build.candidate\)/);
  assert.match(workflow,/guided-private\/receipts\/\*\.json/);assert.match(workflow,/cancel-in-progress: false/);
  assert.doesNotMatch(workflow,/privateKey|facility\.subject\b|GetSecretValue|guided-private\/\*\*/);
  assert.ok(guidedToolingPaths.includes('infra/backend-release'));
  assert.equal(safeGuidedFailure(Error('SQL detail includes PRIVATE_ID')), 'GUIDED_ACTIVATION_FAILED');
  assert.equal(safeGuidedFailure(Error('GUIDED_ACTIVATION_EXACT_BOUND_SELECTION')), 'GUIDED_ACTIVATION_EXACT_BOUND_SELECTION');
  const error=code=>({stderr:'An error occurred ('+code+') when calling the RunTask operation: PRIVATE_DIAGNOSTIC'});
  assert.equal(guidedAwsFailureCode(error('AccessDeniedException')),'ACCESSDENIEDEXCEPTION');
  assert.equal(guidedAwsFailureCode(error('PrivateCustomerIdentifier')),'FAILED');
  assert.equal(guidedAwsFailureCode({stderr:'private prefix '+error('AccessDeniedException').stderr}),'FAILED');
  assert.equal(guidedAwsFailureCode({code:'ETIMEDOUT',stderr:'PRIVATE_DIAGNOSTIC'}),'TIMEOUT');
});
