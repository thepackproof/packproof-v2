import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectInventory,MIGRATION,run} from '../../backend/scripts/measurement-migrate.mjs';
import {BASELINE_COUNT,BASELINE_DIGEST} from '../../backend/scripts/rnd-migrate.mjs';
const directory=new URL('../../backend/migrations/',import.meta.url);
const allInventory=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(async name=>{
 const sql=await readFile(new URL(name,directory),'utf8');return {id:name.slice(0,-4),sql,checksum:createHash('sha256').update(sql).digest('hex')};
}));
// This historical operator is deliberately limited to the original 77-file
// candidate. Later R&D migrations use their separate reviewed operator.
const inventory=allInventory.filter(row=>row.id<'079_');
const receipts=inventory.filter(row=>row.id!==MIGRATION.id).map(({id,checksum})=>({id,checksum}));

test('historical fixture exactly matches the unchanged baseline; the old operator rejects later migrations',()=>{
 assert.equal(inventory.length,BASELINE_COUNT);
 const rows=inventory.map(({id,checksum})=>({id,checksum}));
 assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'),BASELINE_DIGEST);
 assert(allInventory.length>inventory.length);
 assert.throws(()=>inspectInventory(allInventory,receipts),/CANDIDATE_INVENTORY_MISMATCH/);
 assert.throws(()=>inspectInventory([...inventory,{id:'999_unreviewed',sql:'',checksum:'0'.repeat(64)}],receipts),/CANDIDATE_INVENTORY_MISMATCH/);
});
test('requires the exact 77 candidate and unchanged 76 predecessor receipts',()=>{assert.equal(inspectInventory(inventory,receipts).pending,true);});
test('exact already-applied receipt is an idempotent no-op',()=>{assert.equal(inspectInventory(inventory,[...receipts,MIGRATION]).pending,false);});
test('rejects a modified historical receipt',()=>{const rows=structuredClone(receipts);rows[0].checksum='a'.repeat(64);assert.throws(()=>inspectInventory(inventory,rows),/APPLIED_CHECKSUM/);});
test('rejects a missing or unknown historical receipt',()=>{assert.throws(()=>inspectInventory(inventory,receipts.slice(1)),/APPLIED_INVENTORY/);const rows=structuredClone(receipts);rows[0].id='999_unreviewed';assert.throws(()=>inspectInventory(inventory,rows),/APPLIED_CHECKSUM/);});
test('rejects changed 076 SQL even if its claimed digest is unchanged',()=>{const rows=structuredClone(inventory);rows.find(row=>row.id===MIGRATION.id).sql+='\n';assert.throws(()=>inspectInventory(rows,receipts),/MIGRATION_BYTES/);});
test('rejects duplicate candidate or receipt identities',()=>{assert.throws(()=>inspectInventory([...inventory.slice(0,-1),inventory[0]],receipts),/CANDIDATE_INVENTORY/);assert.throws(()=>inspectInventory(inventory,[...receipts.slice(0,-1),receipts[0]]),/APPLIED_INVENTORY/);});
test('operator validates owner/source/rollback inputs before loading any database runtime',async()=>{
 await assert.rejects(run('--inspect',{}),/EXPLICIT_OWNER/);
 const env={PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'x'.repeat(16)};
 await assert.rejects(run('--apply',env),/REVIEWED_SOURCE/);
 await assert.rejects(run('--apply',{...env,PACKPROOF_RELEASE_SHA:'a'.repeat(40),PACKPROOF_MEASUREMENT_MIGRATION_SHA256:MIGRATION.checksum}),/COMPATIBILITY_IMAGE/);
});
