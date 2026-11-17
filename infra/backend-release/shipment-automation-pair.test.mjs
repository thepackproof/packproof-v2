import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectShipmentAutomationPair,readShipmentAutomationPolicy} from './shipment-automation-pair.mjs';
import {reconstructionDigest,shipmentMigrationInventorySha256} from './reconstruction-v7-release-review.mjs';

const now = new Date('2026-11-17T12:00:00Z');
const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/packproof@sha256:'+'7'.repeat(64);
const policy = {bundleSha256:'b'.repeat(64),interpretationVersion:'packproof.shipment-interpretation/v1',
  headerPolicyVersion:'same_names_any_order/v1',interpretationEnabled:true,headerVariantsEnabled:true,
  shadowSourcesSha256:reconstructionDigest(['source-a:2'])};
const review = {schema:'packproof.reconstruction-release-review/v7',source:'a'.repeat(40),inventorySha256:shipmentMigrationInventorySha256,recordsMigrationSha256:'e'.repeat(64),ownerRole:'owner_role',clusterArn:'arn:aws:ecs:us-east-1:123456789012:cluster/pilot',
  candidateImage:image,apiRole:'api_role',workerRole:'worker_role',target:{host:'pilot.invalid',database:'pilot_test'},
  featureActivation:false,customerReleaseQualified:false,automationPolicy:policy,expiresAt:'2026-11-17T13:00:00Z'};
function role(kind,r=review) {
  return {schema:'packproof.reconstruction-runtime-preflight/v7',kind,source:r.source,reviewSha256:reconstructionDigest(r),
    completedAt:now.toISOString(),readOnly:true,customerReleaseQualified:false,identity:{database:r.target.database,role:kind==='api'?r.apiRole:r.workerRole,login:kind==='api'?r.apiRole:r.workerRole,read_only:'on',schema:'public'},
    recordsPrivileges:{caller:kind==='api'?r.apiRole:r.workerRole,sourceCommit:r.source,migrationSha256:r.recordsMigrationSha256},
    m2PrivilegesSha256:'f'.repeat(64),tls:{ssl:true},immutableTriggerVerified:true,
    taskIdentity:{taskArn:r.clusterArn.replace(':cluster/',':task/')+'/'+(kind==='api'?'0':'1').repeat(32),image,imageDigest:image.split('@')[1]},durabilityPolicyMatches:true,
    sourceInventory:{sourceCount:120,appliedCount:120,inventorySha256:r.inventorySha256,migrationsApplied:false,rolesChanged:false,featureActivation:false},
    automationPolicy:{schema:'packproof.shipment-policy-role/v1',kind,...r.automationPolicy,
      workerInterpretation:policy.interpretationVersion,workerHeaderPolicy:policy.headerPolicyVersion}};
}
test('pair requires independent actual-task source, inventory, measured policies and current observations',()=>{
  const api=role('api'), w=role('worker');
  const ok=inspectShipmentAutomationPair(review,api,w,now);
  assert.equal(ok.featureActivation,false);assert.equal(ok.customerReleaseQualified,false);
  for (const invalid of [
    {...w,source:'f'.repeat(40)}, {...w,schema:'packproof.reconstruction-runtime-preflight/v6'}, {...w,reviewSha256:'e'.repeat(64)},
    {...w,taskIdentity:api.taskIdentity},{...w,completedAt:'2026-11-17T11:44:59Z'}, {...w,identity:{...w.identity,role:'api_role'}},
    {...w,sourceInventory:{...w.sourceInventory,appliedCount:119}}, {...w,sourceInventory:{...w.sourceInventory,inventorySha256:'0'.repeat(64)}},
    {...w,automationPolicy:{...w.automationPolicy,bundleSha256:'5'.repeat(64)}}, {...w,automationPolicy:{...w.automationPolicy,workerInterpretation:null}},
    {...w,automationPolicy:{...w.automationPolicy,workerHeaderPolicy:'old'}}, {...w,taskIdentity:{...w.taskIdentity,image:image.replace('7','8')}}])
    assert.throws(()=>inspectShipmentAutomationPair(review,api,invalid,now),/^Error: AUTOMATION_/);
  for(const field of ['interpretationEnabled','headerVariantsEnabled','shadowSourcesSha256']){
    const changed={...api,automationPolicy:{...api.automationPolicy,[field]:field==='shadowSourcesSha256'?'9'.repeat(64):false}};
    assert.throws(()=>inspectShipmentAutomationPair(review,changed,w,now),/SETTINGS_MISMATCH/);
  }
});
test('observe-only pairing never requires activating either policy or inventing a worker declaration',()=>{
  const r={...review,automationPolicy:{...policy,interpretationEnabled:false,headerVariantsEnabled:false}};
  const api=role('api',r),w=role('worker',r);
  api.automationPolicy.workerInterpretation=null;w.automationPolicy.workerHeaderPolicy=null;
  assert.equal(inspectShipmentAutomationPair(r,api,w,now).featureActivation,false);
});
test('role measurement changes on compiled worker byte differences and redacts source IDs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pp-policy-build-'));
  try{
    await mkdir(join(dir,'records'));
    await writeFile(join(dir,'package.json'),'{"type":"module"}');
    await writeFile(join(dir,'index.js'),'// synthetic worker entry');
    for (const f of ['agent-restrictions','csv-semantics','csv','partner-imports','shipment-interpretation-shadow','source-subscriptions','typed-imports'])
      await writeFile(join(dir,'records',f+'.js'),'// synthetic compiled module');
    await writeFile(join(dir,'records','connect-csv-rules.json'),JSON.stringify({interpretation:{version:policy.interpretationVersion}}));
    await writeFile(join(dir,'records','csv-header-policy.js'),"export const CSV_REORDER_POLICY='same_names_any_order/v1';");
    const env={PACKPROOF_SHIPMENT_INTERPRETATION_SHADOW_SOURCES:'sensitive-source:2'};
    const a=await readShipmentAutomationPolicy('api',env,dir);assert.equal(a.shadowSourceCount,1);
    assert.equal(JSON.stringify(a).includes('sensitive-source'),false);
    await writeFile(join(dir,'index.js'),'// differing worker entry');
    const w=await readShipmentAutomationPolicy('worker',env,dir);
    assert.notEqual(w.bundleSha256,a.bundleSha256);
    await assert.rejects(readShipmentAutomationPolicy('api',{...env,PACKPROOF_CSV_HEADER_VARIANTS_ENABLED:'1'},dir),/SWITCH_INVALID/);
    await assert.rejects(readShipmentAutomationPolicy('api',{PACKPROOF_SHIPMENT_INTERPRETATION_SHADOW_SOURCES:'sensitive-source:*'},dir),/SCOPE_INVALID/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
