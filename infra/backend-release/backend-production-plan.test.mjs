import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProductionPlan } from './backend-production-plan.mjs';
import { TARGET } from './backend-deployment-plan.mjs';
const image = `${TARGET.repository}@sha256:${'a'.repeat(64)}`;
function fixture() {
  const env = {NODE_ENV:'production',PACKPROOF_ENVIRONMENT:'staging',PACKPROOF_MIGRATE_ON_START:'false',
    PACKPROOF_AUTH_MODE:'cognito',PACKPROOF_OBJECT_STORAGE:'s3',PACKPROOF_CREDENTIAL_STORE:'secrets-manager',
    PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_DB_SSLMODE:'require',
    PACKPROOF_PUBLIC_URL:'https://api.example.com',PACKPROOF_WEB_ORIGINS:'https://thepackproof.com',
    PACKPROOF_RELEASE_SHA:'a'.repeat(40),PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_VERSION:'previous',
    PACKPROOF_DB_HOST:'customer-db',PACKPROOF_S3_BUCKET:'customer-evidence',PACKPROOF_COGNITO_USER_POOL_ID:'existing-pool'};
  const snapshot = {account:TARGET.account,region:TARGET.region,nativeDeploymentStatus:'SUCCESSFUL',
    service:{serviceArn:TARGET.serviceArn,status:'ACTIVE',desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:'current:45'},
    meta:{environment:'staging',commit:env.PACKPROOF_RELEASE_SHA,image,version:'previous'},
    express:{serviceArn:TARGET.serviceArn,activeConfigurations:[{healthCheckPath:'/health',
      scalingTarget:{minTaskCount:1,maxTaskCount:1,autoScalingMetric:'AVERAGE_CPU',autoScalingTargetValue:60},
      primaryContainer:{image,containerPort:3000,environment:Object.entries(env).map(([name,value])=>({name,value})),
        secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'arn:existing-runtime-secret'}]}}]}};
  const candidate={sourceSha:'b'.repeat(40),image:`${TARGET.repository}@sha256:${'b'.repeat(64)}`,version:'production-test',
    expectedPreviousImage:image,expectedPreviousTaskDefinition:'current:45',ciPassed:true,databasePreflightPassed:true,sourceArchiveVerified:true};
  return {snapshot,candidate};
}
test('promotes in place with exact rollback and preserves every customer binding',()=>{
  const {snapshot,candidate}=fixture(),before=structuredClone(snapshot),plan=makeProductionPlan(snapshot,candidate,{taskCount:2});
  assert.deepEqual(snapshot,before);
  assert.deepEqual(plan.rollback.primaryContainer,snapshot.express.activeConfigurations[0].primaryContainer);
  assert.deepEqual(plan.update.primaryContainer.secrets,plan.rollback.primaryContainer.secrets);
  assert.equal(plan.update.healthCheckPath,'/ready');
  assert.equal(plan.rollback.healthCheckPath,'/health');
  assert.equal(plan.update.scalingTarget.minTaskCount,2);
  const env=Object.fromEntries(plan.update.primaryContainer.environment.map(x=>[x.name,x.value]));
  assert.equal(env.PACKPROOF_ENVIRONMENT,'production');assert.equal(env.PACKPROOF_CREDENTIAL_NAMESPACE,'staging');
  assert.equal(env.PACKPROOF_DB_SSLMODE,'verify-full');assert.equal(env.PACKPROOF_DB_HOST,'customer-db');
  assert.equal(env.PACKPROOF_S3_BUCKET,'customer-evidence');assert.equal(env.PACKPROOF_COGNITO_USER_POOL_ID,'existing-pool');
});
test('later production releases preserve the original namespace',()=>{
  const {snapshot,candidate}=fixture();snapshot.meta.environment='production';
  const env=snapshot.express.activeConfigurations[0].primaryContainer.environment;
  env.find(x=>x.name==='PACKPROOF_ENVIRONMENT').value='production';env.push({name:'PACKPROOF_CREDENTIAL_NAMESPACE',value:'staging'});
  assert.equal(makeProductionPlan(snapshot,candidate).summary.production.credentialNamespace,'staging');
});
test('rejects environment drift, unsafe auth and unreviewed expansion',()=>{
  let {snapshot,candidate}=fixture();snapshot.meta.environment='production';assert.throws(()=>makeProductionPlan(snapshot,candidate));
  ({snapshot,candidate}=fixture());snapshot.express.activeConfigurations[0].primaryContainer.environment.find(x=>x.name==='PACKPROOF_AUTH_MODE').value='dev';
  assert.throws(()=>makeProductionPlan(snapshot,candidate));
  ({snapshot,candidate}=fixture());assert.throws(()=>makeProductionPlan(snapshot,candidate,{taskCount:20}));
});
