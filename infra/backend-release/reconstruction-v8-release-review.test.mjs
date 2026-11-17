import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {inspectReconstructionInventory,reconstructionDigest,backfillMigrationInventorySha256} from './reconstruction-v8-release-review.mjs';
import {inspectReconstructionInventory as inspect121,shipmentMigrationInventorySha256} from './reconstruction-v7-release-review.mjs';
import {runReconstructionPreflight} from './reconstruction-v8-runtime-preflight.mjs';

test('122 widens exactly the 117 installation predicate and pins the entire catalog',async()=>{
 const root=new URL('../../backend/migrations/',import.meta.url);
 const all=(await readdir(root)).filter(name=>name.endsWith('.sql')).sort();
 const names=all.filter(name=>Number(name.slice(0,3))<=122);
 const source=await Promise.all(names.map(async name=>{
  const sql=await readFile(new URL(name,root),'utf8');
  return {id:name.slice(0,-4),sql,checksum:reconstructionDigest(sql)};
 }));
 const body=sql=>sql.match(/FUNCTION record_source_backfill_scope\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/)[1];
 const previous=body(source.find(row=>row.id==='117_source_backfill_jobs').sql);
 const change=source.find(row=>row.id==='122_backfill_collector_041');
 assert.equal(body(change.sql),previous.replace("i.version='0.4.0'","i.version IN ('0.4.0','0.4.1')"));
 const applied=source.map(({id,checksum})=>({id,checksum}));
 const review={inventorySha256:backfillMigrationInventorySha256};
 const inventory=inspectReconstructionInventory(source,applied,review);
 for(const later of all.filter(name=>!names.includes(name))){
  const sql=await readFile(new URL(later,root),'utf8');
  const additional={id:later.slice(0,-4),sql,checksum:reconstructionDigest(sql)};
  assert.throws(()=>inspectReconstructionInventory([...source,additional],applied,review),/SOURCE_INVENTORY/);
 }
 assert.equal(inventory.sourceCount,121);
 assert.equal(inventory.predecessorSha256,shipmentMigrationInventorySha256);
 assert.throws(()=>inspectReconstructionInventory(source.slice(0,-1),applied,review),/SOURCE_INVENTORY/);
 assert.throws(()=>inspectReconstructionInventory(source,applied.slice(0,-1),review),/APPLIED_INVENTORY/);
 assert.throws(()=>inspectReconstructionInventory([...source.slice(0,-1),{...change,sql:change.sql+' '}],applied,review),/SOURCE_INVENTORY/);
 assert.throws(()=>inspect121(source,applied,{inventorySha256:shipmentMigrationInventorySha256}),/SOURCE_INVENTORY/);
});
test('v8 rejects wrong-role or missing-reviewed probes before any target access',async()=>{
 await assert.rejects(runReconstructionPreflight('owner',{}),/PROCESS_ROLE_REQUIRED/);
 await assert.rejects(runReconstructionPreflight('api',{}),/REVIEW_BINDING_REQUIRED/);
});
