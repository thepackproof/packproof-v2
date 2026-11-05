import test from 'node:test';
import assert from 'node:assert/strict';
import {rehearsalTemplate} from './records-rehearsal-task.mjs';
const secret='arn:aws:secretsmanager:us-east-1:784514617543:secret:rds!db-11111111-1111-1111-1111-111111111111-Fixture';
const key='arn:aws:kms:us-east-1:784514617543:key/11111111-1111-1111-1111-111111111111';
const input={sourceSha:'a'.repeat(40),candidateImage:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:'+'b'.repeat(64),bridgeImage:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:'+'c'.repeat(64),compatibilityEvidenceSha256:'d'.repeat(64),clone:{DBInstanceIdentifier:'packproof-records-release-20261105',DBInstanceStatus:'available',PubliclyAccessible:false,StorageEncrypted:true,Endpoint:{Address:'packproof-records-release-20261105.c8v2esku2zyt.us-east-1.rds.amazonaws.com'},MasterUserSecret:{SecretArn:secret,SecretStatus:'active'},VpcSecurityGroups:[{VpcSecurityGroupId:'sg-02b6a3ac5378c28f5'}]},cloneKmsArn:key,runtimeSecretArn:'arn:aws:secretsmanager:us-east-1:784514617543:secret:packproof/staging/database/runtime-v1-8xneOC',runtimeKmsArn:key};
test('rehearsal tasks have no AWS authority and inject only the current clone owner and existing runtime references',async()=>{
 const template=await rehearsalTemplate(input),resources=template.Resources;
 assert.deepEqual(resources.TaskRole.Properties.Policies[0].PolicyDocument.Statement,[{Effect:'Deny',Action:'*',Resource:'*'}]);
 for(const kind of ['OwnerTask','BridgeTask']){
  const task=resources[kind].Properties,container=task.ContainerDefinitions[0];
  assert.equal(task.NetworkMode,'awsvpc');assert.equal(container.ReadonlyRootFilesystem,true);assert.equal(container.User,'1000:1000');
  assert.equal(container.Environment.find(e=>e.Name==='PACKPROOF_DB_HOST').Value,input.clone.Endpoint.Address);
  assert.equal(container.Environment.find(e=>e.Name==='PACKPROOF_DB_SECRET_ARN').Value,'');
  assert.deepEqual(container.Secrets.map(s=>s.Name),['PACKPROOF_DB_USER','PACKPROOF_DB_PASSWORD']);
 }
 const secrets=resources.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement.find(s=>s.Action==='secretsmanager:GetSecretValue').Resource;
 assert.deepEqual(secrets,[secret,input.runtimeSecretArn]);
 assert(!JSON.stringify(template).includes('rds!db-8f5824eb-60e0-4f3a-ac2c-630dbb0f734a-RjNM96'));
 const bridge=resources.BridgeTask.Properties.ContainerDefinitions[0].Command;
 assert.deepEqual(bridge.slice(4),['records-bridge-preflight',input.sourceSha,input.bridgeImage.split('@')[1],'baseline']);
});
for(const [name,change] of [
 ['production endpoint',{clone:{...input.clone,Endpoint:{Address:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'}}}],
 ['production owner secret',{clone:{...input.clone,MasterUserSecret:{SecretArn:'arn:aws:secretsmanager:us-east-1:784514617543:secret:rds!db-8f5824eb-60e0-4f3a-ac2c-630dbb0f734a-RjNM96',SecretStatus:'active'}}}],
 ['public database',{clone:{...input.clone,PubliclyAccessible:true}}],
 ['wrong subnet security group',{clone:{...input.clone,VpcSecurityGroups:[{VpcSecurityGroupId:'sg-other'}]}}],
 ['mutable image',{candidateImage:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api:latest'}],
 ['different runtime secret',{runtimeSecretArn:secret}],
])test('rejects '+name,async()=>{await assert.rejects(rehearsalTemplate({...input,...change}),/^Error: RECORDS_/);});
