// Hosted PostgreSQL 16 lock profile for the unchanged migration-122 inventory.
import {
  reconstructionDigest, validateReconstructionReview as validateInventoryReview
} from './reconstruction-v8-release-review.mjs';
import {hostedLockPolicySha256} from './hosted-membership-locks.mjs';
export {
  reconstructionDigest, validateReconstructionTaskMetadata, inspectReconstructionInventory, verifyBackfillScopeGuard
} from './reconstruction-v8-release-review.mjs';

export function validateReconstructionReview(review, expectedHash, source, now=new Date()) {
  if (review?.schema !== 'packproof.reconstruction-release-review/v9' ||
      reconstructionDigest(review) !== expectedHash || review.platformLockPolicySha256 !== hostedLockPolicySha256)
    throw Error('RECONSTRUCTION_HOSTED_LOCK_REVIEW_REQUIRED');
  const {platformLockPolicySha256: _lockPolicy, ...shared} = review;
  const inventoryReview = {...shared, schema:'packproof.reconstruction-release-review/v8'};
  validateInventoryReview(inventoryReview, reconstructionDigest(inventoryReview), source, now);
  return expectedHash;
}
