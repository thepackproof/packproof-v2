// Separate118 projection admission. Frozen117 source/profile guards remain,
// never widened to admit a different source inventory or activation decision.
import {reconstructionDigest,validateReconstructionReview as validate116Review,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks} from './reconstruction-v2-release-review.mjs';
export {reconstructionDigest,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks};
const fail=code=>{throw Error(code);};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
const predecessor='57d54b44d9f6d3e43db003da2159c4e1cf191cfc5d8acbe5e2c361939d91cf8b';
const addition='118_source_projection_rechecks';
export function validateReconstructionReview(review,expectedHash,source,now=new Date()){
 if(review?.schema!=='packproof.reconstruction-release-review/v4'||reconstructionDigest(review)!==expectedHash)fail('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');
 // All existing source/image/target, actual-role, expiry and non-activation
 // requirements still apply. Only this wrapper accepts the new review schema.
 const predecessorReview={...review,schema:'packproof.reconstruction-release-review/v2'};
 validate116Review(predecessorReview,reconstructionDigest(predecessorReview),source,now);
 return expectedHash;
}
export function inspectReconstructionInventory(inventory,applied,review){
 const normalized=entries(inventory),base=normalized.filter(row=>row.id!==addition);
 if(inventory.length!==117||new Set(inventory.map(row=>row.id)).size!==117||inventory.filter(row=>row.id===addition).length!==1||reconstructionDigest(base)!==predecessor||reconstructionDigest(normalized)!==review.inventorySha256||inventory.some(row=>typeof row.sql!=='string'||reconstructionDigest(row.sql)!==row.checksum))fail('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
 if(applied.length!==normalized.length||new Set(applied.map(row=>row.id)).size!==applied.length||reconstructionDigest(entries(applied))!==review.inventorySha256)fail('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
 return {sourceCount:normalized.length,appliedCount:applied.length,inventorySha256:review.inventorySha256,predecessorSha256:predecessor,additions:normalized.filter(row=>row.id===addition),migrationsApplied:false,rolesChanged:false,featureActivation:false};
}
