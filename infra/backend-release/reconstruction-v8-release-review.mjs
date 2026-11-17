import {
  reconstructionDigest, validateReconstructionReview as validateShipmentReview,
  shipmentMigrationInventorySha256, validateReconstructionTaskMetadata, inspectReconstructionPlatformLocks,
} from './reconstruction-v7-release-review.mjs';
export {reconstructionDigest,validateReconstructionTaskMetadata,inspectReconstructionPlatformLocks};

export const backfillMigrationInventorySha256='ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804';
export const backfillRecordsInventorySha256='11b3a0e163438a2ea9f8122f76857866154be6b901b4abbcec4cf780d0625f38';
const addition={id:'122_backfill_collector_041',checksum:'11eb66a36bd4378c8df71fc57d5c146eb90c83f1945a19b1e48c9ac10e5eef5f'};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));

export function validateReconstructionReview(review,expectedHash,source,now=new Date()){
 if(review?.schema!=='packproof.reconstruction-release-review/v8'||reconstructionDigest(review)!==expectedHash||
    review.inventorySha256!==backfillMigrationInventorySha256||review.recordsMigrationSha256!==backfillRecordsInventorySha256||
    typeof review.backfillJobsEnabled!=='boolean')throw Error('RECONSTRUCTION_REVIEW_BINDING_REQUIRED');
 // Reuse the shipment role, policy, source, image and expiry checks. The
 // replacement inventory is verified independently above and again at runtime.
 const shipment={...review,schema:'packproof.reconstruction-release-review/v7',inventorySha256:shipmentMigrationInventorySha256};
 validateShipmentReview(shipment,reconstructionDigest(shipment),source,now);
 return expectedHash;
}

export function inspectReconstructionInventory(inventory,applied,review){
 const source=entries(inventory);
 if(source.length!==121||review.inventorySha256!==backfillMigrationInventorySha256||
    reconstructionDigest(source)!==backfillMigrationInventorySha256||
    inventory.some(row=>typeof row.sql!=='string'||reconstructionDigest(row.sql)!==row.checksum))throw Error('RECONSTRUCTION_SOURCE_INVENTORY_MISMATCH');
 if(applied.length!==source.length||reconstructionDigest(entries(applied))!==backfillMigrationInventorySha256)throw Error('RECONSTRUCTION_APPLIED_INVENTORY_MISMATCH');
 return {sourceCount:source.length,appliedCount:applied.length,inventorySha256:backfillMigrationInventorySha256,
  predecessorSha256:shipmentMigrationInventorySha256,additions:[addition],migrationsApplied:false,rolesChanged:false,featureActivation:false};
}

export async function verifyBackfillScopeGuard(db,ddl){
 const body=ddl.match(/LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/)?.[1];
 const expected=new Map([
  ['record_source_backfill_jobs','record_source_backfill_job_scope'],
  ['record_source_backfill_decisions','record_source_backfill_decision_scope'],
  ['record_source_backfill_receipts','record_source_backfill_receipt_scope'],
 ]);
 const rows=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgnargs,
   t.tgqual IS NULL AS unconditional,t.tgattr::text AS columns,p.prosrc,p.prosecdef,
   p.proconfig IS NULL AS default_settings,l.lanname,pg_get_userbyid(p.proowner)=pg_get_userbyid(c.relowner) AS table_owner
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
   WHERE c.relnamespace=current_schema()::regnamespace AND p.pronamespace=c.relnamespace
     AND p.proname='record_source_backfill_scope' AND NOT t.tgisinternal AND t.tgname=ANY($1::text[])`,[[...expected.values()]])).rows;
 if(typeof body!=='string'||rows.length!==expected.size||rows.some(row=>
  expected.get(row.relname)!==row.tgname||!expected.delete(row.relname)|| !['O','A'].includes(row.tgenabled)||row.tgtype!==7||row.tgnargs!==0||
  !row.unconditional||row.columns!==''||row.prosrc!==body||row.prosecdef!==false||
  !row.default_settings||row.lanname!=='plpgsql'||!row.table_owner))throw Error('BACKFILL_SCOPE_GUARD_MISMATCH');
}
