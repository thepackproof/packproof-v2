import {reconstructionDigest,validateReconstructionTaskMetadata,verifyBackfillScopeGuard,
 validateReconstructionReview as validateHostedReview} from './reconstruction-v9-release-review.mjs';
import {backfillMigrationInventorySha256,backfillRecordsInventorySha256} from './reconstruction-v8-release-review.mjs';
export {reconstructionDigest,validateReconstructionTaskMetadata,verifyBackfillScopeGuard};
export const workspaceInventory='ce2f00a3cee6b8139fc6323830e787e781dab7780da93c8d4b23deaa742c1b4d';
export const workspaceRecords='fc90a9edbe22cc22fa5f553096d9d7b9da8a3bde62ad3784ef117abdb6147001';
export const workspaceMigration={id:'123_order_workspace',checksum:'941c88e20122caaaab739ee28f791d5b65157a6bb4acd347c4ff7e2e3801c1bd'};
export function validateReconstructionReview(r,expectedHash,source,now=new Date()){
 if(r?.schema!=='packproof.reconstruction-release-review/v10'||reconstructionDigest(r)!==expectedHash||
    r.inventorySha256!==workspaceInventory||r.recordsMigrationSha256!==workspaceRecords||r.orderWorkspaceEnabled!==false)
  throw Error('RECONSTRUCTION_WORKSPACE_REVIEW_REQUIRED');
 const prior={...r,schema:'packproof.reconstruction-release-review/v9',inventorySha256:backfillMigrationInventorySha256,recordsMigrationSha256:backfillRecordsInventorySha256};
 validateHostedReview(prior,reconstructionDigest(prior),source,now);
 return expectedHash;
}
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
export function inspectReconstructionInventory(source,applied,review){
 const sorted=entries(source);
 if(sorted.length!==122 || review.inventorySha256!==workspaceInventory || reconstructionDigest(sorted)!==workspaceInventory ||
    reconstructionDigest(sorted.slice(0,-1))!==backfillMigrationInventorySha256 || source.some(row=>typeof row.sql!=='string'||reconstructionDigest(row.sql)!==row.checksum))
  throw Error('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
 if(reconstructionDigest(entries(applied))!==workspaceInventory)throw Error('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
 return {sourceCount:sorted.length,appliedCount:applied.length,inventorySha256:workspaceInventory,predecessorSha256:backfillMigrationInventorySha256,
  additions:[workspaceMigration],migrationsApplied:false,rolesChanged:false,featureActivation:false};
}
export async function verifyOrderHistoryGuards(db){
 const expected=new Set(['record_order_receipts','record_order_events','record_order_revisions','record_order_decisions']);
 const rows=(await db.query(`SELECT c.relname,t.tgenabled,t.tgtype,t.tgnargs,t.tgqual IS NULL unconditional,
  p.proname,p.prosecdef,r.rolname AS owner FROM pg_trigger t JOIN pg_class c ON t.tgrelid=c.oid
  JOIN pg_proc p ON t.tgfoid=p.oid JOIN pg_roles r ON r.oid=c.relowner
  WHERE c.relnamespace='public'::regnamespace AND p.pronamespace=c.relnamespace
  AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal AND p.proname='platform_record_immutable'`,[[...expected]])).rows;
 if(rows.length!==4 || rows.some(row=>!expected.delete(row.relname)||!['O','A'].includes(row.tgenabled)||
  row.tgtype!==27||row.tgnargs!==0||!row.unconditional||row.prosecdef!==false))throw Error('ORDER_WORKSPACE_IMMUTABILITY_GUARD');
}
