import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {TARGET} from './backend-deployment-plan.mjs';
import {prepareRecoveryFacilityInspection,runRecoveryFacilityInspection,collectRecoveryFacilityInspection} from './recovery-facility-inspection.mjs';
import {encryptFacilityReceipt,facilityEnvelopeHeader} from './logistics-facility-inspect.mjs';

const source='a'.repeat(40),image=TARGET.repository+'@sha256:'+'b'.repeat(64),now=Date.parse('2026-11-23T22:00:00Z');
const cluster='arn:aws:ecs:us-east-1:784514617543:cluster/'+TARGET.cluster;
const taskArn=cluster.replace(':cluster/',':task/')+'/'+'c'.repeat(32);
const role='arn:aws:iam::784514617543:role/';
const inventorySha256='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
const recipient=generateKeyPairSync('x25519');
const recipientPublicKeySpki=recipient.publicKey.export({type:'spki',format:'der'}).toString('base64');
const subjectSha256=createHash('sha256').update('11111111-2222-4333-8444-555555555555').digest('hex');
function fixture() {
  const family='packproof-v2-staging-cluster-packproof-v2-staging-api';
  const taskDefinitionArn='arn:aws:ecs:us-east-1:784514617543:task-definition/'+family+':64';
  const values={PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_VERSION:'retained129',
    PACKPROOF_PROCESS_ROLE:'api',PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',
    PACKPROOF_DB_HOST:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',PACKPROOF_DB_NAME:'packproof_v2',
    PACKPROOF_ORDER_WORKSPACE_ENABLED:'true',PACKPROOF_GUIDED_FACILITIES:'organization:sandbox:location'};
  const container={name:'api',image,environment:Object.entries(values).map(([name,value])=>({name,value})),
    secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'retained-runtime-reference'}],
    logConfiguration:{logDriver:'awslogs',options:{'awslogs-region':'us-east-1','awslogs-group':'/ecs/packproof-v2-staging-api','awslogs-stream-prefix':'ecs'}}};
  const service={serviceArn:TARGET.serviceArn,clusterArn:cluster,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:taskDefinitionArn,
    networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-123'],securityGroups:['sg-123'],assignPublicIp:'ENABLED'}},launchType:'FARGATE'};
  const snapshot={account:TARGET.account,region:TARGET.region,observedAt:new Date(now).toISOString(),api:{service,
    taskDefinition:{family,taskDefinitionArn,status:'ACTIVE',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],
      taskRoleArn:role+'packproof-records-v1-api',executionRoleArn:role+'packproof-records-v1-api-execution',containerDefinitions:[container]},
    express:{serviceArn:TARGET.serviceArn,activeConfigurations:[{primaryContainer:structuredClone(container)}]},
    meta:{commit:source,image,version:values.PACKPROOF_RELEASE_VERSION},nativeDeploymentStatus:'SUCCESSFUL',
    tasks:[{taskArn,clusterArn:cluster,group:'service:'+TARGET.serviceName,taskDefinitionArn,lastStatus:'RUNNING',desiredStatus:'RUNNING',
      containers:[{name:'api',lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}]}};
  const prepared=prepareRecoveryFacilityInspection({snapshot,subjectSha256,recipientPublicKeySpki,inventorySha256,runId:'123'},now);
  const registered={...structuredClone(prepared.request),taskDefinitionArn:'arn:aws:ecs:us-east-1:784514617543:task-definition/'+prepared.request.family+':1',status:'ACTIVE'};
  const task={taskArn,clusterArn:cluster,taskDefinitionArn:registered.taskDefinitionArn,lastStatus:'STOPPED',
    containers:[{name:'api',lastStatus:'STOPPED',exitCode:0,imageDigest:image.split('@')[1]}]};
  const report={schema:'packproof.logistics-facility-inspection/v1',source,image,inventorySha256,actualTask:taskArn,
    readOnly:true,rolledBack:true,completedAt:new Date(now).toISOString(),userId:'user_example',installations:[],totalMatchingInstallations:0,truncated:false};
  const envelope=encryptFacilityReceipt(report,subjectSha256,recipientPublicKeySpki);
  const receipt={prepared,registered,task,events:[{message:JSON.stringify(envelope)}],logGroup:prepared.logGroup,
    logStream:prepared.logPrefix+'/api/'+taskArn.split('/').at(-1)};
  return {snapshot,prepared,registered,report,envelope,receipt};
}

test('the fixed one-shot inspector retains the actual API source, image, role, credentials, flags and network',()=>{
  const f=fixture(),original=f.snapshot.api.taskDefinition.containerDefinitions[0],c=f.prepared.request.containerDefinitions[0];
  assert.equal(f.prepared.source,source);assert.equal(c.image,image);
  assert.deepEqual(c.environment,original.environment);assert.deepEqual(c.secrets,original.secrets);
  assert.equal(f.prepared.request.taskRoleArn,f.snapshot.api.taskDefinition.taskRoleArn);
  assert.equal(f.prepared.request.executionRoleArn,f.snapshot.api.taskDefinition.executionRoleArn);
  assert.ok(Buffer.byteLength(JSON.stringify(c.command))<7800);
  assert.match(c.command[3],/FACILITY_CODE_BINDING/);
  const run=runRecoveryFacilityInspection(f,now);
  assert.deepEqual(run.networkConfiguration,f.snapshot.api.service.networkConfiguration);
  assert.equal(run.count,1);assert.equal(run.enableExecuteCommand,false);assert.equal(run.overrides,undefined);
  assert.deepEqual(collectRecoveryFacilityInspection(f.receipt,now),{envelope:f.envelope,header:facilityEnvelopeHeader(f.envelope)});
});

test('wrong subject, ledger, live identity or stale observation cannot construct or launch the inspector',()=>{
  const f=fixture(),args={snapshot:f.snapshot,subjectSha256,recipientPublicKeySpki,inventorySha256,runId:'123'};
  for(const changed of [{subjectSha256:'Example workstation'},{subjectSha256:'11111111-2222-4333-8444-555555555555'},{inventorySha256:'f'.repeat(64)}])
    assert.throws(()=>prepareRecoveryFacilityInspection({...args,...changed},now),/SUBJECT_OR_LEDGER/);
  assert.throws(()=>prepareRecoveryFacilityInspection({...args,snapshot:{...f.snapshot,observedAt:new Date(now-901000).toISOString()}},now),/FRESH_OBSERVATION/);
  f.snapshot.api.meta.commit='d'.repeat(40);
  assert.throws(()=>runRecoveryFacilityInspection(f,now),/API_TRAFFIC_OR_IDENTITY/);
});

test('receipt verification rejects command drift, task overrides, wrong image, bad logs and replayed or ambiguous results',()=>{
  for(const mutate of [
    f=>f.registered.containerDefinitions[0].command.push('unreviewed'),
    f=>f.task.overrides={containerOverrides:[{name:'api',command:['other']}]},
    f=>f.task.containers[0].imageDigest='sha256:'+'f'.repeat(64),
    f=>f.logStream+='other',
    f=>f.events.push(f.events[0]),
    f=>{const r=JSON.parse(f.events[0].message),h=facilityEnvelopeHeader(r);h.source='d'.repeat(40);r.protected=Buffer.from(JSON.stringify(h)).toString('base64');f.events[0].message=JSON.stringify(r);},
    f=>{const r=JSON.parse(f.events[0].message),h=facilityEnvelopeHeader(r);h.completedAt=new Date(now-901000).toISOString();r.protected=Buffer.from(JSON.stringify(h)).toString('base64');f.events[0].message=JSON.stringify(r);}
  ]) {const f=fixture().receipt;mutate(f);assert.throws(()=>collectRecoveryFacilityInspection(f,now));}
});
