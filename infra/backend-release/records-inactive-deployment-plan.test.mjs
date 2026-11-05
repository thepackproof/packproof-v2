import test from 'node:test';
import assert from 'node:assert/strict';
import {TARGET} from './backend-deployment-plan.mjs';
import {SOURCE,BRIDGE,APPLICATION,PREDECESSOR,inactiveApplicationPlan} from './records-inactive-deployment-plan.mjs';
function fixture(){
 const env={PACKPROOF_RELEASE_SHA:SOURCE,PACKPROOF_RELEASE_IMAGE:BRIDGE,PACKPROOF_RELEASE_VERSION:'bridge',PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_WEB_ORIGINS:'https://thepackproof.com',PACKPROOF_PUBLIC_URL:'https://example.invalid',PACKPROOF_TRUSTED_PROXIES:'10.20.0.0/24,10.20.1.0/24'};
 const snapshot={account:TARGET.account,region:TARGET.region,service:{serviceArn:TARGET.serviceArn,status:'ACTIVE',taskDefinition:PREDECESSOR,desiredCount:1,runningCount:1,pendingCount:0},express:{serviceArn:TARGET.serviceArn,activeConfigurations:[{primaryContainer:{image:BRIDGE,containerPort:3000,environment:Object.entries(env).map(([name,value])=>({name,value})),secrets:[{name:'DB_PASSWORD',valueFrom:'reference-only'}]}}]},nativeDeploymentStatus:'SUCCESSFUL',meta:{commit:SOURCE,image:BRIDGE,version:'bridge'}};
 const qualification={taskStopped:true,exitCode:0,actualImage:APPLICATION,ciPassed:true,sourceArchiveVerified:true,receipt:{event:'records_inactive_app_preflight',source:SOURCE,image:APPLICATION,processRole:'api',databaseReadOnly:true,workersStarted:false,featuresActivated:false,identity:{role:'packproof_app_runtime_v1',login:'packproof_app_runtime_v1',database:'packproof_v2',schema:'public',default_read_only:'on'},tls:{ssl:true},migrationCount:106,migrationSha256:'605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1',checks:['/meta','/health','/ready'].map(route=>({route,status:200,cors:'https://thepackproof.com'}))}};
 return {snapshot,qualification};
}
test('same source SHA admits only the measured bridge-to-application transition and preserves configuration',()=>{
 const {snapshot,qualification}=fixture(),before=structuredClone(snapshot),p=inactiveApplicationPlan(snapshot,qualification);
 assert.equal(p.update.primaryContainer.image,APPLICATION);assert.equal(p.rollback.primaryContainer.image,BRIDGE);
 assert.deepEqual(snapshot,before);assert.deepEqual(p.update.primaryContainer.secrets,before.express.activeConfigurations[0].primaryContainer.secrets);
 assert.equal(p.update.primaryContainer.containerPort,3000);assert.equal(p.summary.recordsActivationQualified,false);
 assert(p.update.primaryContainer.environment.some(x=>x.name==='PACKPROOF_TRUSTED_PROXIES'&&x.value==='10.20.0.0/24,10.20.1.0/24'));
});
const bad=[
 ['different account',(s)=>{s.account='000000000000';}],
 ['predecessor revision drift',(s)=>{s.service.taskDefinition=PREDECESSOR.replace(':50',':51');}],
 ['rollout in progress',(s)=>{s.nativeDeploymentStatus='IN_PROGRESS';}],
 ['active records feature',(s)=>{s.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_ORGANIZATIONS_ENABLED',value:'true'});}],
 ['durable profile activation',(s)=>{s.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_REQUIRE_DURABLE_RECEIPTS',value:'true'});}],
 ['duplicate secret/environment binding',(s)=>{s.express.activeConfigurations[0].primaryContainer.environment.push({name:'DB_PASSWORD',value:'invalid'});}],
 ['unverified source archive',(_s,q)=>{q.sourceArchiveVerified=false;}],
 ['wrong actual image',(_s,q)=>{q.actualImage=BRIDGE;}],
 ['failed probe',(_s,q)=>{q.exitCode=1;}],
 ['owner login',(_s,q)=>{q.receipt.identity.role='packproof';}],
 ['write-capable probe',(_s,q)=>{q.receipt.identity.default_read_only='off';}],
 ['partial migration ledger',(_s,q)=>{q.receipt.migrationCount=94;}],
 ['wrong SQL checksum',(_s,q)=>{q.receipt.migrationSha256='0'.repeat(64);}],
 ['missing readiness check',(_s,q)=>{q.receipt.checks.pop();}],
 ['wrong CORS origin',(_s,q)=>{q.receipt.checks[0].cors='*';}],
];
for(const [name,change] of bad)test('rejects '+name,()=>{const {snapshot,qualification}=fixture();change(snapshot,qualification);assert.throws(()=>inactiveApplicationPlan(snapshot,qualification),/^Error: INACTIVE_/);});
