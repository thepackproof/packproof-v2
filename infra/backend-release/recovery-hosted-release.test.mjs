import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hash} from './backend-deployment-plan.mjs';
import {reconstructionDigest,hostedCollectorTarget} from './reconstruction-v11-release-review.mjs';
import {recoverySessionPolicy,authorizeCoordinatorPhase,ownerReviewFromReceipt} from './recovery-hosted-release.mjs';
import {validateRecoveryOwnerReview,recoveryInventory,recoveryReviewSchema} from './recovery-hosted-migration.mjs';

const source='a'.repeat(40),role=name=>'arn:aws:iam::784514617543:role/'+name;
// Nonsecret family/role/log identifiers from the reviewed Nov21 deployment.
const definition=kind=>({family:kind==='api'?'packproof-v2-staging-cluster-packproof-v2-staging-api':'packproof-records-production-worker',
  taskRoleArn:role('packproof-records-v1-'+kind),executionRoleArn:role('packproof-records-v1-'+kind+'-execution'),
  containerDefinitions:[{environment:[{name:'PACKPROOF_PROCESS_ROLE',value:kind}],logConfiguration:{options:{
    'awslogs-group':kind==='api'?'/ecs/packproof-v2-staging-api':'/ecs/packproof-records-worker'}}}]});
const snapshot={api:{taskDefinition:definition('api'),express:{infrastructureRoleArn:role('packproof-v2-staging-infrastructure')}},
  worker:{taskDefinition:definition('worker'),service:{serviceArn:'arn:aws:ecs:us-east-1:784514617543:service/packproof-v2-staging-cluster/packproof-records-worker'}}};
const owner={ownerLaunch:{executionRoleArn:role('packproof-v2-staging-execution')}};

test('phase-scoped sessions fit the actual retained runtime identities without granting secret reads or role writes',()=>{
  const observed={...snapshot,api:{...snapshot.api,meta:{commit:'b'.repeat(40)}}};
  for(const stage of ['inspect','hydrate','build','runtime','owner','facility']) {
    const text=recoverySessionPolicy(stage,{source,snapshot:observed,owner,runId:'123'});
    assert.ok(Buffer.byteLength(text)<=2048,stage);
    assert.doesNotMatch(text,/GetSecretValue|UpdateAssumeRole|PutRolePolicy|CreateRole|Delete|rds:\*/);
    const policy=JSON.parse(text);
    if(['inspect','hydrate'].includes(stage))assert.ok(policy.Statement.every(s=>[s.Action].flat().every(a=>/:(?:Get|Describe|List|BatchGet|Simulate)/.test(a))));
    if(stage==='runtime') {
      const updates=policy.Statement.filter(s=>[s.Action].flat().some(a=>a.includes('Update')));
      assert.equal(updates.length,2);assert.ok(updates.every(s=>s.Resource.startsWith('arn:aws:ecs:us-east-1:784514617543:service/')));
      const passed=policy.Statement.filter(s=>s.Action==='iam:PassRole');
      assert.ok(passed.every(s=>!JSON.stringify(s.Resource).includes('*')));
    }
    if(stage==='owner')assert.ok(!text.includes('UpdateService')&&!text.includes('UpdateExpressGatewayService'));
    if(stage==='facility') {
      assert.ok(!text.includes('UpdateService')&&!text.includes('UpdateExpressGatewayService')&&!text.includes('records-v1-worker'));
      assert.match(text,/packproof-security-verifier-bbbbbbbbbbbb-123/);
      assert.doesNotMatch(text,/packproof-security-verifier-aaaaaaaaaaaa/);
    }
  }
  assert.throws(()=>recoverySessionPolicy('runtime',{source,snapshot:{...snapshot,api:{...snapshot.api,express:{}}},owner}),/INFRASTRUCTURE_ROLE/);
});

test('one reviewed phase cannot execute a broader phase or an automatic full rollout',()=>{
  for(const requested of ['inspect','facility-inspect','build','bridge','rehearse','apply','promote'])authorizeCoordinatorPhase('inspect',requested);
  authorizeCoordinatorPhase('fallback','bridge');authorizeCoordinatorPhase('apply','apply');authorizeCoordinatorPhase('candidate','promote');
  authorizeCoordinatorPhase('facility-inspect','facility-inspect');
  for(const [phase,requested] of [['apply','inspect'],['apply','rehearse'],['fallback','build'],['candidate','bridge'],['build','release'],['policy-owner','promote'],['facility-inspect','inspect'],['policy-facility','apply']])
    assert.throws(()=>authorizeCoordinatorPhase(phase,requested),/REQUESTED_PHASE_MISMATCH/);
});

test('owner receipt pins survive phase handoff using the owner protocol digest, never canonical configuration hashing',()=>{
  const images={candidate:'candidate-image',fallback:'bridge-image'};
  const review={schema:'packproof.hosted-recovery-migration/v1',source,candidateImage:images.candidate,bridgeImage:images.fallback,expiresAt:'2026-11-24T00:00:00Z'};
  const pin=reconstructionDigest(review);
  assert.notEqual(hash(review),pin,'This fixture must distinguish the two protocols.');
  const receipt={registered:{containerDefinitions:[{environment:[{name:'PACKPROOF_HOSTED_MIGRATION_REVIEW_JSON',value:JSON.stringify(review)}]}]},
    report:{schema:'packproof.hosted-recovery-owner-receipt/v1',mode:'rehearse',rolledBack:true,reviewSha256:pin,source,image:images.candidate}};
  assert.deepEqual(ownerReviewFromReceipt(receipt,pin,source,images),review);
  assert.throws(()=>ownerReviewFromReceipt(receipt,hash(review),source,images),/OWNER_REVIEW_PIN_CHANGED/);
  assert.throws(()=>ownerReviewFromReceipt(receipt,pin,'b'.repeat(40),images),/OWNER_REVIEW_PIN_CHANGED/);
  const forged=structuredClone(receipt);forged.report.rolledBack=false;
  assert.throws(()=>ownerReviewFromReceipt(forged,pin,source,images),/OWNER_REVIEW_PIN_CHANGED/);
});

test('the130 owner refuses a different source, unknown ledger, expired review or absent rollback rehearsal',()=>{
  const now=new Date('2026-11-23T22:00:00Z');
  const review={schema:recoveryReviewSchema,source,
    candidateImage:hostedCollectorTarget.repository+'@sha256:'+'c'.repeat(64),
    bridgeImage:hostedCollectorTarget.repository+'@sha256:'+'b'.repeat(64),
    clusterArn:hostedCollectorTarget.clusterArn,target:{host:hostedCollectorTarget.host,database:hostedCollectorTarget.database},
    inventorySha256:recoveryInventory,expectedLedger:'8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc',
    ownerRole:'packproof',apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',
    expiresAt:'2026-11-23T23:00:00Z'};
  const env={PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:review.candidateImage,
    PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ORDER_WORKSPACE_ENABLED:'false'};
  const validate=(r=review,e=env,mode='rehearse')=>validateRecoveryOwnerReview(r,reconstructionDigest(r),mode,e,now);
  validate();
  assert.throws(()=>validate(review,{...env,PACKPROOF_RELEASE_SHA:'d'.repeat(40)}),/REVIEW_BINDING/);
  assert.throws(()=>validate({...review,expectedLedger:'f'.repeat(64)}),/PREDECESSOR_REVIEW/);
  assert.throws(()=>validate({...review,expiresAt:now.toISOString()}),/REVIEW_EXPIRED/);
  assert.throws(()=>validate(review,env,'apply'),/REHEARSAL_REQUIRED/);
});

test('reviewed request-file pushes use main OIDC and publish only redacted receipts',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/connect-recovery-release.yml',import.meta.url),'utf8');
  assert.match(workflow,/paths: \['infra\/connect-rollout\/recovery-promotion\.json'\]/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/EXACT_SOURCE_MAIN_CI_REQUIRED/);
  assert.match(workflow,/recovery-private\/receipts\/\*\.json/);
  assert.match(workflow,/ENCRYPTED_FACILITY_REQUEST_REQUIRED/);
  assert.match(workflow,/inventorySha256,recipientPublicKeySpki,subjectSha256/);
  assert.doesNotMatch(workflow,/facility-private\.json|private-connect-facility-|request\.facility\.subject\b/);
  assert.doesNotMatch(workflow,/backend-release-runner\.mjs|AdministratorAccess|GetSecretValue/);
  const ci=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  assert.match(ci,/tests\/connect-recovery-privileges\.test\.ts/);
});

test('CodeBuild build reads use its exact project authorization resource, never a build ARN',()=>{
  const project='arn:aws:codebuild:us-east-1:784514617543:project/packproof-v2-staging-api';
  for(const stage of ['build','hydrate']) {
    const policy=JSON.parse(recoverySessionPolicy(stage,{source,snapshot,owner}));
    const statementsFor=action=>policy.Statement.filter(statement=>[statement.Action].flat().includes(action));
    assert.deepEqual(statementsFor('codebuild:BatchGetBuilds').map(s=>s.Resource),[project]);
    assert.deepEqual(statementsFor('codebuild:ListBuildsForProject').map(s=>s.Resource),stage==='build'?[project]:[]);
    assert.deepEqual(statementsFor('codebuild:StartBuild').map(s=>s.Resource),stage==='build'?[project]:[]);
    assert.ok(policy.Statement.filter(s=>[s.Action].flat().some(a=>/^codebuild:(BatchGetBuilds|ListBuildsForProject|StartBuild)$/.test(a)))
      .every(s=>s.Resource===project));
    assert.doesNotMatch(JSON.stringify(policy),/:build\/|\bcodebuild:\*/);
  }
});
