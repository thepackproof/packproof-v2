import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, TARGET } from './backend-deployment-plan.mjs';
const image = `${TARGET.repository}@sha256:${'a'.repeat(64)}`;
function fixture() {
  const snapshot = { account: TARGET.account, region: TARGET.region,
    nativeDeploymentStatus: 'SUCCESSFUL',
    service: { serviceArn: TARGET.serviceArn, status: 'ACTIVE', desiredCount: 3, runningCount: 3, pendingCount: 0, taskDefinition: 'reviewed:51' },
    meta: { commit: 'a'.repeat(40), image, version: 'previous' },
    express: { serviceArn: TARGET.serviceArn, activeConfigurations: [{ cpu: '2048', memory: '4096', healthCheckPath: '/ready',
      primaryContainer: { image, containerPort: 3000, command: ['node', 'dist/index.js'],
        environment: [
          ['PACKPROOF_MIGRATE_ON_START','false'], ['PACKPROOF_ENVIRONMENT','staging'], ['PACKPROOF_WEB_ORIGINS','https://thepackproof.com'],
          ['PACKPROOF_PUBLIC_URL','https://example.invalid'], ['PACKPROOF_RELEASE_SHA','a'.repeat(40)], ['PACKPROOF_RELEASE_IMAGE',image],
          ['PACKPROOF_RELEASE_VERSION','previous'], ['PACKPROOF_SIGNING_MODE','kms'], ['PACKPROOF_SHOPIFY_ENABLED','true']
        ].map(([name,value]) => ({name,value})), secrets: [{name:'PACKPROOF_DB_PASSWORD',valueFrom:'arn:example:runtime-secret:password::'}] }
    }] }
  };
  const candidate = { sourceSha: 'b'.repeat(40), image: `${TARGET.repository}@sha256:${'b'.repeat(64)}`, version: 'security-review',
    expectedPreviousImage: image, expectedPreviousTaskDefinition: 'reviewed:51', ciPassed: true, databasePreflightPassed: true, sourceArchiveVerified: true };
  return { snapshot, candidate };
}
test('changes only image and three release bindings, preserves three tasks and larger resources', () => {
  const {snapshot,candidate}=fixture(),before=structuredClone(snapshot),result=makePlan(snapshot,candidate);
  assert.deepEqual(snapshot,before);
  assert.deepEqual(Object.keys(result.update),['serviceArn','primaryContainer']);
  assert.equal(result.summary.desiredCount,3);
  assert.deepEqual(result.rollback.primaryContainer,snapshot.express.activeConfigurations[0].primaryContainer);
  assert.deepEqual(result.update.primaryContainer.secrets,result.rollback.primaryContainer.secrets);
  assert.equal(result.update.primaryContainer.environment.find(x=>x.name==='PACKPROOF_SHOPIFY_ENABLED').value,'true');
  assert.equal(JSON.stringify(result.summary).includes('arn:example'),false);
});
for(const [name,modify] of [
  ['wrong account',s=>{s.account='000000000000';}],
  ['duplicate env',s=>{s.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_RELEASE_SHA',value:'evil'});}],
  ['env/secret collision',s=>{s.express.activeConfigurations[0].primaryContainer.secrets.push({name:'PACKPROOF_RELEASE_SHA',valueFrom:'opaque'});}],
  ['automatic migration',s=>{s.express.activeConfigurations[0].primaryContainer.environment[0].value='true';}],
  ['ambiguous configuration',s=>{s.express.activeConfigurations.push(structuredClone(s.express.activeConfigurations[0]));}],
  ['zero desired count',s=>{s.service.desiredCount=0;s.service.runningCount=0;}],
  ['unsettled native rollout',s=>{s.nativeDeploymentStatus='IN_PROGRESS';}],
  ['public source mismatch',s=>{s.meta.commit='c'.repeat(40);}]
]) test(`rejects ${name}`,()=>{const {snapshot,candidate}=fixture();modify(snapshot);assert.throws(()=>makePlan(snapshot,candidate));});
for(const [name,modify] of [
  ['mutable tag',c=>{c.image=`${TARGET.repository}:latest`;}],
  ['lookalike repository hostname',c=>{c.image=`${TARGET.repository.replace('.amazonaws.com','-amazonaws.com')}@sha256:${'b'.repeat(64)}`;}],
  ['untrusted repository suffix',c=>{c.image=`${TARGET.repository}.example.invalid@sha256:${'b'.repeat(64)}`;}],
  ['digest suffix',c=>{c.image=`${TARGET.repository}@sha256:${'b'.repeat(64)}?unexpected`;}],
  ['stale baseline',c=>{c.expectedPreviousTaskDefinition='old:1';}],
  ['missing database gate',c=>{c.databasePreflightPassed=false;}],
  ['missing source proof',c=>{c.sourceArchiveVerified=false;}],
  ['missing CI gate',c=>{c.ciPassed=false;}]
]) test(`rejects ${name}`,()=>{const {snapshot,candidate}=fixture();modify(candidate);assert.throws(()=>makePlan(snapshot,candidate));});
