import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {m2BridgeDeploymentPlan as plan,M2_BRIDGE as bridge} from './m2-bridge-deployment-plan.mjs';
import {TARGET} from './backend-deployment-plan.mjs';
const now=new Date('2026-10-22T19:00:00Z');
const migrations=new URL('../../backend/migrations/',import.meta.url);
// This fixture describes the reviewed October 22 bridge BEFORE 093. Later
// source migrations belong to a different deployment program; excluding just
// 093-095 would accidentally import 096+ into this historical receipt set.
const historicalBridgeFiles=names=>names.filter(name=>/^\d{3}_.+\.sql$/.test(name)&&name<'093_').sort();
const migrationNames=await readdir(migrations);
const applied=await Promise.all(historicalBridgeFiles(migrationNames).map(async name=>({id:name.slice(0,-4),checksum:createHash('sha256').update(await readFile(new URL(name,migrations))).digest('hex')})));
function fixture(){
 const environment=Object.entries({PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'false',PACKPROOF_S3_BUCKET:'packproof-v2-evidence-staging-20260829-a7f3',PACKPROOF_RELEASE_SHA:bridge.previousSource,PACKPROOF_RELEASE_IMAGE:bridge.previousImage,PACKPROOF_RELEASE_VERSION:'foundation'}).map(([name,value])=>({name,value}));
 const primaryContainer={image:bridge.previousImage,containerPort:3000,environment,secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'runtime-reference'}]};
 const snapshot={account:TARGET.account,region:TARGET.region,observedAt:now.toISOString(),nativeDeploymentStatus:'SUCCESSFUL',meta:{commit:bridge.previousSource,image:bridge.previousImage,version:'foundation'},
  service:{serviceArn:TARGET.serviceArn,status:'ACTIVE',taskDefinition:'reviewed:48',desiredCount:1,runningCount:1,pendingCount:0,deploymentConfiguration:{strategy:'CANARY',canaryConfiguration:{canaryPercent:5,canaryBakeTimeInMinutes:3},bakeTimeInMinutes:3,minimumHealthyPercent:100,maximumPercent:200,deploymentCircuitBreaker:{enable:true,rollback:true},alarms:{enable:true,rollback:true,alarmNames:['reviewed-alarm']}}},
  express:{serviceArn:TARGET.serviceArn,activeConfigurations:[{taskDefinitionArn:'reviewed:48',serviceRevisionArn:'reviewed-revision',primaryContainer}]}};
 const receipts=['bootstrap','before','migrate','after'].map(mode=>({mode,status:'PASSED',source:bridge.source,harness:bridge.harness,image:bridge.image,syntheticOnly:true,productionChanged:false,checks:mode==='after'?['pre_migration_approved_download_is_byte_identical','new_m2_tables_remain_unreadable_to_bridge','accepted_terminal_row_cannot_change']:[]}));
 const candidate={source:bridge.source,image:bridge.image,version:'1.0.3-m2-bridge-399f306a',expectedPreviousRevision:'reviewed-revision',expectedPreviousImage:bridge.previousImage,
  build:{status:'SUCCEEDED',source:bridge.source,image:bridge.image},scan:{status:'COMPLETE',image:bridge.image,findings:{}},
  preflight:{status:'PASSED',source:bridge.source,image:bridge.image,observedAt:now.toISOString(),identity:{role:'packproof_app_runtime_v1',login:'packproof_app_runtime_v1',database:'packproof_v2',read_only:'on'},tls:{ssl:true},runtimeAuthoritySafe:true,organizationCount:0,inFlightRecipientJobs:0,durabilityPolicyMatches:true,exactVersionsVerified:29,committedEvidenceCount:29,signedVerified:21,legacyUnsigned:0,manifestCount:21,sourceMigrationCount:91,applied:structuredClone(applied)},
  compatibility:{status:'PASSED',receipts,cleanup:{status:'PASSED',containerRemoved:true,fixtureVolumeRemoved:true,networkRemoved:true}},
  ci:{backend:{source:bridge.source,status:'PASSED'},postgres:{source:bridge.source,status:'PASSED'},web:{source:bridge.harness,status:'PASSED'},sourceSecurity:{source:bridge.harness,status:'PASSED'},overlay:{base:bridge.source,head:bridge.harness,changedPaths:['.gitleaksignore','backend/scripts/m2-bridge-compatibility-acceptance.mjs','web/src/tests/app.test.tsx']}}};
 return {snapshot,candidate};
}
test('pins the historical fixture to the exact 91 pre-093 receipts despite later source migrations',()=>{
 const reviewed=historicalBridgeFiles(migrationNames);
 assert.equal(applied.length,91);
 assert.equal(createHash('sha256').update(JSON.stringify(applied)).digest('hex'),bridge.baseline);
 assert.deepEqual(historicalBridgeFiles([...migrationNames,
  '093_integrity_envelope_jobs.sql','095_recipient_export_preservation.sql',
  '096_api_proof_snapshots.sql','100_api_projection_events.sql','101_future.sql']),reviewed);
});
test('still refuses later-schema preflights rather than treating the historical bridge as a new release operator',()=>{
 for(const id of ['096_api_proof_snapshots','100_api_projection_events']){
  const {snapshot,candidate}=fixture();
  candidate.preflight.applied.push({id,checksum:'unreviewed'});
  assert.throws(()=>plan(snapshot,candidate,now),/BRIDGE_MUST_PRECEDE_MIGRATION/);
 }
});
test('changes only the immutable image and release identity, preserving secrets and rollback',()=>{
 const {snapshot,candidate}=fixture(),before=structuredClone(snapshot),result=plan(snapshot,candidate,now);
 assert.deepEqual(snapshot,before);assert.deepEqual(Object.keys(result.update),['serviceArn','primaryContainer']);
 assert.deepEqual(result.update.primaryContainer.secrets,result.rollback.primaryContainer.secrets);
 assert.deepEqual(result.rollback.primaryContainer,before.express.activeConfigurations[0].primaryContainer);
 assert.equal(result.summary.schemaMutation,false);assert.equal(result.summary.organizationActivation,false);
 assert.match(result.summary.rollbackBoundary,/only before 093-095/);
});
for(const [name,mutate,code] of [
 ['changed predecessor',f=>{f.snapshot.meta.image=bridge.image;},'PUBLIC_RUNTIME_IDENTITY_MISMATCH'],
 ['concurrent deployment',f=>{f.snapshot.nativeDeploymentStatus='IN_PROGRESS';},'PREDECESSOR_NOT_STABLE'],
 ['expired preservation proof',f=>{f.candidate.preflight.observedAt='2026-10-22T18:00:00Z';},'FRESH_IMAGE_PREFLIGHT_REQUIRED'],
 ['owner session disguised as runtime',f=>{f.candidate.preflight.identity.login='packproof';},'READ_ONLY_NON_OWNER_REQUIRED'],
 ['missing original version',f=>{f.candidate.preflight.exactVersionsVerified--;},'PRESERVATION_PREFLIGHT_REQUIRED'],
 ['schema migrated before bridge',f=>{f.candidate.preflight.applied.push({id:'093_integrity_envelope_jobs',checksum:'unreviewed'});},'BRIDGE_MUST_PRECEDE_MIGRATION'],
 ['changed baseline checksum',f=>{f.candidate.preflight.applied[0].checksum='f'.repeat(64);},'BASELINE_DIGEST_REQUIRED'],
 ['activation flag',f=>{f.snapshot.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_CLAIM_EXPORTS_ENABLED',value:'true'});},'ACTIVATION_NOT_ALLOWED'],
 ['new application in test overlay',f=>{f.candidate.ci.overlay.changedPaths.push('backend/src/server-app.ts');},'UNREVIEWED_TEST_OVERLAY'],
 ['unpassed backend source',f=>{f.candidate.ci.backend.status='RUNNING';},'EXACT_RUNTIME_CI_REQUIRED'],
 ['unclean isolated fixture',f=>{f.candidate.compatibility.cleanup.fixtureVolumeRemoved=false;},'COMPATIBILITY_CLEANUP_REQUIRED'],
 ['missing automatic rollback alarm',f=>{f.snapshot.service.deploymentConfiguration.alarms.alarmNames=[];},'CANARY_AND_ROLLBACK_REQUIRED'],
])test('blocks '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>plan(f.snapshot,f.candidate,now),new RegExp(code));});
