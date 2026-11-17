import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {inspectReconstructionInventory,reconstructionDigest,shipmentMigrationInventorySha256} from './reconstruction-v7-release-review.mjs';
import {inspectReconstructionInventory as frozen120} from './reconstruction-v6-release-review.mjs';
import {runReconstructionPreflight} from './reconstruction-v7-runtime-preflight.mjs';

test('the exact v7 source inventory matches all applied bytes and preserves the previous 120 gate',async()=>{
  const root=new URL('../../backend/migrations/',import.meta.url);
  const names=(await readdir(root)).filter(name=>name.endsWith('.sql')).sort();
  const source=await Promise.all(names.map(async name=>{
    const sql=await readFile(new URL(name,root),'utf8');
    return {id:name.slice(0,-4),sql,checksum:reconstructionDigest(sql)};
  }));
  const applied=source.map(({id,checksum})=>({id,checksum}));
  const review={inventorySha256:shipmentMigrationInventorySha256};
  const observed=inspectReconstructionInventory(source,applied,review);
  assert.equal(observed.sourceCount,120);assert.equal(observed.appliedCount,120);assert.equal(observed.additions[0].id,'121_shipment_interpretation_decisions');
  assert.throws(()=>frozen120(source,applied,review),/SOURCE_INVENTORY_MISMATCH/);
  assert.equal(frozen120(source.slice(0,-1),applied.slice(0,-1),{inventorySha256:observed.predecessorSha256}).sourceCount,119);
  assert.throws(()=>inspectReconstructionInventory(source,applied.slice(0,-1),review),/APPLIED/);
  assert.throws(()=>inspectReconstructionInventory(source,[...applied,{...applied[0]}],review),/APPLIED/);
  assert.throws(()=>inspectReconstructionInventory(source.map((r,i)=>i===119?{...r,sql:r.sql+' '}:r),applied,review),/SOURCE/);
  assert.throws(()=>inspectReconstructionInventory(source,applied.map((r,i)=>i===4?{...r,checksum:'a'.repeat(64)}:r),review),/APPLIED/);
});
test('rejects a missing or wrong-role opt-in probe before metadata, database or activation',async()=>{
  await assert.rejects(runReconstructionPreflight('owner',{}),/PROCESS_ROLE_REQUIRED/);
  await assert.rejects(runReconstructionPreflight('worker',{}),/REVIEW_BINDING_REQUIRED/);
});
