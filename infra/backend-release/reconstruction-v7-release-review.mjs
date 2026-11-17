// The first automation candidate adds exactly the immutable shipment decision.
// The v6 profile and the deployed 108-image release keep their original limits.
import {
  reconstructionDigest, validateReconstructionReview as validatePredecessorReview,
  validateReconstructionTaskMetadata, inspectReconstructionPlatformLocks,
} from './reconstruction-v6-release-review.mjs';
export {reconstructionDigest,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks};
const additions = [{id:'121_shipment_interpretation_decisions',checksum:'c6759ae088ff6eb220f6c179c22ee26931e0740abf19565da0bb5889eadaa6c7'}];
export const shipmentMigrationInventorySha256 = '3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5';
const predecessorSha256 = '698c4a3e92a71be18e5ee01e3e6a5dacc0b33ac79342b20a66836bc8c218f791';
const entries = rows => rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
export function validateReconstructionReview(review, expectedHash, source, now=new Date()) {
  if (review?.schema !== 'packproof.reconstruction-release-review/v7' || reconstructionDigest(review) !== expectedHash)
    throw Error('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');
  const predecessor = {...review,schema:'packproof.reconstruction-release-review/v6'};
  validatePredecessorReview(predecessor,reconstructionDigest(predecessor),source,now);
  const p = review.automationPolicy;
  if (review.inventorySha256 !== shipmentMigrationInventorySha256 || !p || !/^[a-f0-9]{64}$/.test(p.bundleSha256) ||
      !/^[a-f0-9]{64}$/.test(p.shadowSourcesSha256) || typeof p.interpretationEnabled !== 'boolean' ||
      typeof p.headerVariantsEnabled !== 'boolean' || p.interpretationVersion !== 'packproof.shipment-interpretation/v1' ||
      p.headerPolicyVersion !== 'same_names_any_order/v1') throw Error('AUTOMATION_REVIEW_REQUIRED');
  return expectedHash;
}
export function inspectReconstructionInventory(inventory, applied, review) {
  const source = entries(inventory);
  if (source.length !== 120 || review.inventorySha256 !== shipmentMigrationInventorySha256 ||
      reconstructionDigest(source) !== shipmentMigrationInventorySha256 ||
      inventory.some(row=>typeof row.sql !== 'string' || reconstructionDigest(row.sql) !== row.checksum))
    throw Error('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
  if (applied.length !== source.length || reconstructionDigest(entries(applied)) !== shipmentMigrationInventorySha256)
    throw Error('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
  return {sourceCount:source.length,appliedCount:applied.length,inventorySha256:shipmentMigrationInventorySha256,
    predecessorSha256,additions,migrationsApplied:false,rolesChanged:false,featureActivation:false};
}
