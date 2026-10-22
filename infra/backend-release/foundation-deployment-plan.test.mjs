import test from 'node:test';
import assert from 'node:assert/strict';
import {foundationDeploymentPlan as plan,FOUNDATION_SOURCES as sources} from './foundation-deployment-plan.mjs';
import {TARGET} from './backend-deployment-plan.mjs';
const now=new Date('2026-10-22T04:00:00Z'),image=x=>TARGET.repository+'@sha256:'+x.repeat(64);
function fixture(){
 const environment=Object.entries({PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'false',PACKPROOF_S3_BUCKET:'packproof-v2-evidence-staging-20260829-a7f3',PACKPROOF_RELEASE_SHA:sources.previous,PACKPROOF_RELEASE_IMAGE:image('a'),PACKPROOF_RELEASE_VERSION:'previous'}).map(([name,value])=>({name,value}));
 const config={taskDefinitionArn:'reviewed:46',serviceRevisionArn:'reviewed-revision',primaryContainer:{image:image('a'),environment,secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'runtime-secret-reference'}]}};
 const snapshot={account:TARGET.account,region:TARGET.region,observedAt:now.toISOString(),nativeDeploymentStatus:'SUCCESSFUL',meta:{commit:sources.previous,image:image('a'),version:'previous'},
  service:{serviceArn:TARGET.serviceArn,status:'ACTIVE',taskDefinition:'reviewed:46',desiredCount:1,runningCount:1,pendingCount:0,deploymentConfiguration:{strategy:'CANARY',canaryConfiguration:{canaryPercent:5,canaryBakeTimeInMinutes:3},bakeTimeInMinutes:3,minimumHealthyPercent:100,maximumPercent:200,deploymentCircuitBreaker:{enable:true,rollback:true},alarms:{enable:true,rollback:true}}},
  express:{serviceArn:TARGET.serviceArn,activeConfigurations:[config]}};
 const candidate={stage:'bridge',sourceSha:sources.bridge,image:image('b'),version:'bridge',expectedPreviousRevision:'reviewed-revision',expectedPreviousImage:image('a'),build:{status:'SUCCEEDED',source:sources.bridge,image:image('b')},scan:{status:'COMPLETE',image:image('b'),findings:{}},
  preflight:{status:'PASSED',source:sources.bridge,image:image('b'),observedAt:now.toISOString(),runtimeAuthorityUnchanged:true,durabilityPolicyMatches:true,organizationCount:0,exactVersionsVerified:29,committedEvidenceCount:29,signedVerified:21,legacyUnsigned:0,manifestCount:21,applied:Array(86).fill({}),sourceMigrationCount:86},
  compatibility:{status:'PASSED',bridgeSource:sources.bridge,candidateSource:sources.candidate,rejectsActivation:true}};
 return {snapshot,candidate};
}
test('preserves every non-release binding and the complete rollback request',()=>{
 const {snapshot,candidate}=fixture(),before=structuredClone(snapshot),r=plan(snapshot,candidate,now);
 assert.deepEqual(snapshot,before);assert.deepEqual(Object.keys(r.update),['serviceArn','primaryContainer']);
 assert.deepEqual(r.update.primaryContainer.secrets,r.rollback.primaryContainer.secrets);
 assert.deepEqual(r.rollback.primaryContainer,snapshot.express.activeConfigurations[0].primaryContainer);
 assert.equal(r.summary.organizationActivation,false);assert.equal(r.summary.desiredCount,1);
});
test('candidate requires the migrated schema, tested bridge predecessor and exact-source CI',()=>{
 const f=fixture(),container=f.snapshot.express.activeConfigurations[0].primaryContainer;
 f.snapshot.meta.commit=sources.bridge;
 container.environment.find(e=>e.name==='PACKPROOF_RELEASE_SHA').value=sources.bridge;
 Object.assign(f.candidate,{stage:'candidate',sourceSha:sources.candidate});
 f.candidate.build.source=sources.candidate;
 Object.assign(f.candidate.preflight,{source:sources.candidate,sourceMigrationCount:91,applied:Array(91).fill({})});
 assert.throws(()=>plan(f.snapshot,f.candidate,now),/EXACT_CANDIDATE_CI_REQUIRED/);
 f.candidate.ci={status:'PASSED',source:sources.candidate};
 assert.equal(plan(f.snapshot,f.candidate,now).summary.stage,'candidate');
 f.candidate.preflight.applied.pop();
 assert.throws(()=>plan(f.snapshot,f.candidate,now),/MIGRATION_BOUNDARY_MISMATCH/);
});
for(const [name,change] of [
 ['stale snapshot',f=>{f.snapshot.observedAt='2026-10-21T00:00:00Z';}],
 ['concurrent deployment',f=>{f.snapshot.nativeDeploymentStatus='IN_PROGRESS';}],
 ['changed task revision',f=>{f.snapshot.service.taskDefinition='other:47';}],
 ['organization activation',f=>{f.snapshot.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_ORGANIZATIONS_ENABLED',value:'true'});}],
 ['wrong original bucket',f=>{f.snapshot.express.activeConfigurations[0].primaryContainer.environment.find(e=>e.name==='PACKPROOF_S3_BUCKET').value='other';}],
 ['missing version verification',f=>{f.candidate.preflight.exactVersionsVerified=28;}],
 ['stale preflight',f=>{f.candidate.preflight.observedAt='2026-10-21T00:00:00Z';}],
 ['schema already migrated before bridge',f=>{f.candidate.preflight.applied.push({});}],
 ['missing automatic rollback',f=>{f.snapshot.service.deploymentConfiguration.deploymentCircuitBreaker.rollback=false;}],
 ['unreviewed source',f=>{f.candidate.sourceSha='a'.repeat(40);}],
 ['mutable image tag',f=>{f.candidate.image=TARGET.repository+':latest';}],
 ['scan finding',f=>{f.candidate.scan.findings.HIGH=1;}],
 ['failed build',f=>{f.candidate.build.status='FAILED';}],
 ['unsafe rollback after activation',f=>{f.candidate.compatibility.rejectsActivation=false;}],
])test('rejects '+name,()=>{const f=fixture();change(f);assert.throws(()=>plan(f.snapshot,f.candidate,now));});
