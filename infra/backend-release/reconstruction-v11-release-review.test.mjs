import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {recordsMigrationInventory} from '../../backend/scripts/records-runtime-privileges.mjs';
import {hostedLockPolicySha256} from './hosted-membership-locks.mjs';
import {inspectReconstructionInventory as inspectWorkspace, workspaceInventory, workspaceRecords} from './reconstruction-v10-release-review.mjs';
import {
  collectorInventory, collectorRecords, collectorMigration, reconstructionDigest, inspectCollectorPredecessor,
  inspectReconstructionInventory, validateReconstructionReview,
} from './reconstruction-v11-release-review.mjs';

const dir = new URL('../../backend/migrations/', import.meta.url);
const source = await Promise.all((await readdir(dir)).filter(file =>
  file.endsWith('.sql') && Number(file.slice(0, 3)) <= 124).sort().map(async file => {
    const sql = await readFile(new URL(file, dir), 'utf8');
    return {id: file.slice(0, -4), checksum: reconstructionDigest(sql), sql};
  }));
const applied = source.map(({id, checksum}) => ({id, checksum}));
const prior = applied.slice(0, -1);

test('collector qualification admits only exact predecessor and post-migration ledgers', async () => {
  assert.equal((await recordsMigrationInventory(124)).migrationSha256, collectorRecords);
  assert.equal((await recordsMigrationInventory(123)).migrationSha256, workspaceRecords);
  const inspect = rows => inspectReconstructionInventory(source, rows, {inventorySha256: collectorInventory});
  assert.deepEqual(inspectCollectorPredecessor(source, prior), {
    appliedCount: 122, predecessorSha256: workspaceInventory, addition: collectorMigration,
  });
  assert.deepEqual(inspect([...applied].reverse()), {
    sourceCount: 123, appliedCount: 123, inventorySha256: collectorInventory, predecessorSha256: workspaceInventory,
    additions: [collectorMigration], migrationsApplied: false, rolesChanged: false, featureActivation: false,
  });
  for (const rows of [prior.slice(0, -1), applied, [...prior.slice(0, -1), prior[0]]]) {
    assert.throws(() => inspectCollectorPredecessor(source, rows), /PREDECESSOR_MISMATCH/);
  }
  assert.throws(() => inspect(prior), /APPLIED_INVENTORY/);
  assert.throws(() => inspect([...applied, {id: '125_unknown', checksum: '0'.repeat(64)}]), /APPLIED_INVENTORY/);
  assert.throws(() => inspect([...prior, {...collectorMigration, checksum: '0'.repeat(64)}]), /APPLIED_INVENTORY/);
  assert.throws(() => inspectReconstructionInventory(source, applied, {inventorySha256: workspaceInventory}), /SOURCE_INVENTORY/);
  assert.throws(() => inspectWorkspace(source, applied, {inventorySha256: workspaceInventory}), /SOURCE_INVENTORY/);
  for (const changedId of ['123_order_workspace', collectorMigration.id]) {
    for (const rehash of [false, true]) {
      const damaged = source.map(row => {
        if (row.id !== changedId) return row;
        const sql = row.sql + ' ';
        return {...row, sql, checksum: rehash ? reconstructionDigest(sql) : row.checksum};
      });
      assert.throws(() => inspectReconstructionInventory(damaged, applied, {inventorySha256: collectorInventory}), /SOURCE_INVENTORY/);
    }
  }
});

test('candidate review binds exact source and target, inherited policy and UTC expiry', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const sourceCommit = 'a'.repeat(40);
  const review = {
    schema: 'packproof.reconstruction-release-review/v11', source: sourceCommit, inventorySha256: collectorInventory,
    recordsMigrationSha256: collectorRecords, platformLockPolicySha256: hostedLockPolicySha256,
    candidateImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test@sha256:' + '7'.repeat(64),
    clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/isolated', target: {host: 'isolated.example.test', database: 'test_db'},
    backfillJobsEnabled: false, orderWorkspaceEnabled: false, featureActivation: false, customerReleaseQualified: false,
    ownerRole: 'owner_role', apiRole: 'api_role', workerRole: 'worker_role', expiresAt: '2026-11-18T12:30:00Z',
    automationPolicy: {bundleSha256: 'b'.repeat(64), interpretationVersion: 'packproof.shipment-interpretation/v1',
      headerPolicyVersion: 'same_names_any_order/v1', interpretationEnabled: false, headerVariantsEnabled: false,
      shadowSourcesSha256: reconstructionDigest([])},
  };
  const check = (r, hash = reconstructionDigest(r)) => validateReconstructionReview(r, hash, sourceCommit, now);
  assert.equal(check(review), reconstructionDigest(review));
  assert.throws(() => check(review, '0'.repeat(64)), /REVIEW_REQUIRED/);
  for (const change of [
    {source: 'e'.repeat(40)}, {inventorySha256: workspaceInventory}, {recordsMigrationSha256: workspaceRecords},
    {schema: 'packproof.reconstruction-release-review/v10'}, {platformLockPolicySha256: 'a'.repeat(64)},
    {orderWorkspaceEnabled: true}, {featureActivation: true}, {customerReleaseQualified: true},
    {apiRole: review.ownerRole}, {expiresAt: '2026-11-18T11:00:00Z'},
    {clusterArn: review.clusterArn.replace('/isolated', '/packproof-v2-staging-cluster')},
    {target: {...review.target, host: 'packproof-v2-staging-db.example.test'}},
  ]) assert.throws(() => check({...review, ...change}));
});
