// Separate120 durable shipment-work admission. Frozen119 source/profile guards remain,
// never widened to admit a different source inventory or activation decision.
import {reconstructionDigest,validateReconstructionReview as validate116Review,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks} from './reconstruction-v2-release-review.mjs';
export {reconstructionDigest,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks};
const fail=code=>{throw Error(code);};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
const predecessor='884ffae0bbbe510796908602d1893b9c7b9c48564ae12190166c9157d09cca87';
const addition='120_typed_shipment_projection_work';
export function validateReconstructionReview(review,expectedHash,source,now=new Date()){
 if(review?.schema!=='packproof.reconstruction-release-review/v6'||reconstructionDigest(review)!==expectedHash)fail('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');
 // All existing source/image/target, actual-role, expiry and non-activation
 // requirements still apply. Only this wrapper accepts the new review schema.
 const predecessorReview={...review,schema:'packproof.reconstruction-release-review/v2'};
 validate116Review(predecessorReview,reconstructionDigest(predecessorReview),source,now);
 return expectedHash;
}
export function inspectReconstructionInventory(inventory,applied,review){
 const normalized=entries(inventory),base=normalized.filter(row=>row.id!==addition);
 if(inventory.length!==119||new Set(inventory.map(row=>row.id)).size!==119||inventory.filter(row=>row.id===addition).length!==1||reconstructionDigest(base)!==predecessor||reconstructionDigest(normalized)!==review.inventorySha256||inventory.some(row=>typeof row.sql!=='string'||reconstructionDigest(row.sql)!==row.checksum))fail('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
 if(applied.length!==normalized.length||new Set(applied.map(row=>row.id)).size!==applied.length||reconstructionDigest(entries(applied))!==review.inventorySha256)fail('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
 return {sourceCount:normalized.length,appliedCount:applied.length,inventorySha256:review.inventorySha256,predecessorSha256:predecessor,additions:normalized.filter(row=>row.id===addition),migrationsApplied:false,rolesChanged:false,featureActivation:false};
}
