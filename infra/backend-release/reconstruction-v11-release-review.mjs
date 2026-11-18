import {
  reconstructionDigest,
  validateReconstructionReview as validateWorkspaceReview,
  workspaceInventory,
  workspaceRecords,
} from './reconstruction-v10-release-review.mjs';

export {
  reconstructionDigest, validateReconstructionTaskMetadata, verifyBackfillScopeGuard, verifyOrderHistoryGuards,
} from './reconstruction-v10-release-review.mjs';

export const collectorInventory = 'd0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60';
export const collectorRecords = '9a5c36ffce4a536d3f6bb6a44ca7b724fe6a350f4397c8529ee7db93cf4c4d20';
export const collectorGrants = '116375351f3b52951faa169428970ea7fa7573da71509060af2c7b2ccfb5081d';
export const collectorMigration = Object.freeze({
  id: '124_connect_collector_version',
  checksum: '66db31ba54b918122ede837715987c19273c8c76aecf4fd1b7a278d161eaa5be',
});

export function validateReconstructionReview(review, expectedHash, source, now = new Date()) {
  if (review?.schema !== 'packproof.reconstruction-release-review/v11' || reconstructionDigest(review) !== expectedHash ||
      review.inventorySha256 !== collectorInventory || review.recordsMigrationSha256 !== collectorRecords) {
    throw Error('RECONSTRUCTION_COLLECTOR_REVIEW_REQUIRED');
  }
  const workspaceReview = {
    ...review, schema: 'packproof.reconstruction-release-review/v10',
    inventorySha256: workspaceInventory, recordsMigrationSha256: workspaceRecords,
  };
  validateWorkspaceReview(workspaceReview, reconstructionDigest(workspaceReview), source, now);
  const cluster = review.clusterArn.split('/').at(-1);
  const host = review.target.host.toLowerCase().split('.')[0];
  if (['packproof-v2-staging-cluster', 'packproof-staging-cluster'].includes(cluster) ||
      ['packproof-v2-staging-db', 'packproof-staging-databaseb269d8bb-ho0dvlroifdz'].includes(host)) {
    throw Error('RECONSTRUCTION_ISOLATED_TARGET_REQUIRED');
  }
  return expectedHash;
}

function entries(rows) {
  return rows.map(({id, checksum}) => ({id, checksum})).sort((a, b) => a.id.localeCompare(b.id));
}

function verifySource(source) {
  const sorted = entries(source);
  if (sorted.length !== 123 || reconstructionDigest(sorted) !== collectorInventory ||
      reconstructionDigest(sorted.slice(0, -1)) !== workspaceInventory ||
      source.some(row => typeof row.sql !== 'string' || reconstructionDigest(row.sql) !== row.checksum)) {
    throw Error('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
  }
}

/** Read-only qualification of the complete ledger before a separately approved 123-to-124 migration. */
export function inspectCollectorPredecessor(source, applied) {
  verifySource(source);
  if (applied.length !== 122 || reconstructionDigest(entries(applied)) !== workspaceInventory) {
    throw Error('RECONSTRUCTION_COLLECTOR_PREDECESSOR_MISMATCH');
  }
  return {appliedCount: applied.length, predecessorSha256: workspaceInventory, addition: collectorMigration};
}

export function inspectReconstructionInventory(source, applied, review) {
  verifySource(source);
  if (review?.inventorySha256 !== collectorInventory) throw Error('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
  if (applied.length !== 123 || reconstructionDigest(entries(applied)) !== collectorInventory) {
    throw Error('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
  }
  return {
    sourceCount: source.length, appliedCount: applied.length,
    inventorySha256: collectorInventory, predecessorSha256: workspaceInventory, additions: [collectorMigration],
    migrationsApplied: false, rolesChanged: false, featureActivation: false,
  };
}
