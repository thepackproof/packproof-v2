import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceInventory,workspaceMigration,reconstructionDigest,inspectReconstructionInventory,verifyOrderHistoryGuards} from './reconstruction-v10-release-review.mjs';

test('workspace admission checks all SQL bytes, exact applied inventory and the four immutable history tables',async()=>{
 const dir=new URL('../../backend/migrations/',import.meta.url);
 const source=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.sql')&&Number(n.slice(0,3))<=123).sort().map(async n=>{
  const sql=await readFile(new URL(n,dir),'utf8');return {id:n.slice(0,-4),checksum:reconstructionDigest(sql),sql};
 }));
 const review={inventorySha256:workspaceInventory};
 assert.equal(inspectReconstructionInventory(source,source,review).sourceCount,122);
 assert.throws(()=>inspectReconstructionInventory(source,source.slice(0,-1),review),/APPLIED_INVENTORY/);
 assert.throws(()=>inspectReconstructionInventory([...source.slice(0,-1),{...source.at(-1),sql:source.at(-1).sql+' '}],source,review),/SOURCE_INVENTORY/);
 const names=['record_order_receipts','record_order_events','record_order_revisions','record_order_decisions'];
 const rows=names.map(relname=>({relname,tgenabled:'O',tgtype:27,tgnargs:0,unconditional:true,prosecdef:false}));
 const db={query:async()=>({rows})};
 await verifyOrderHistoryGuards(db);
 rows[1].tgenabled='D';
 await assert.rejects(()=>verifyOrderHistoryGuards(db),/IMMUTABILITY_GUARD/);
});

test('the compatibility bridge preserves the predecessor allowlist and admits only the pinned 123 receipt',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'packproof-bridge-'));
 try{
  const old={id:'allowed-old',checksum:'1'.repeat(64)};
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await writeFile(path.join(root,'forward-compatible-migrations.previous.js'),`export const FORWARD_COMPATIBLE_MIGRATIONS=[${JSON.stringify(old)}]; export const isReviewedForwardCompatibleMigration=r=>FORWARD_COMPATIBLE_MIGRATIONS.some(v=>r.id===v.id&&r.checksum===v.checksum);`);
  await writeFile(path.join(root,'guard.js'),await readFile(new URL('./order-workspace-forward-read.mjs',import.meta.url)));
  const guard=await import(pathToFileURL(path.join(root,'guard.js')).href);
  assert.ok(guard.isReviewedForwardCompatibleMigration(old));
  assert.ok(guard.isReviewedForwardCompatibleMigration(workspaceMigration));
  assert.equal(guard.isReviewedForwardCompatibleMigration({...workspaceMigration,checksum:'f'.repeat(64)}),false);
  assert.equal(guard.isReviewedForwardCompatibleMigration({...workspaceMigration,id:'124_unreviewed'}),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
