import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {migrationInventory} from '../src/db/migrate.js';
// Source admission is deliberately an operator module, not an application write.
// @ts-expect-error Reviewed plain-JavaScript operator does not have TS declarations.
import {inspectSourceAssociationInventory} from '../scripts/source-association-migration-inventory.mjs';
describe('109 source association release inventory',()=>{
 it('admits only exact108 predecessor or complete109 receipts and never changes the database',async()=>{
  const rows=await migrationInventory(),manifest=JSON.parse(await readFile(new URL('../scripts/source-association-migration-manifest.json',import.meta.url),'utf8'));
  const previous=rows.filter(r=>r.id!=='109_source_associations'),review={reviewedSourceCommit:'a'.repeat(40),reviewedInventorySha256:manifest.inventorySha256};
  expect(inspectSourceAssociationInventory(rows,previous,review)).toMatchObject({pending:true,sourceCount:108,appliedCount:107,migrationApplied:false,rolesChanged:false,featureActivation:false});
  expect(inspectSourceAssociationInventory(rows,rows,review).pending).toBe(false);
  expect(()=>inspectSourceAssociationInventory(rows,previous,{...review,reviewedSourceCommit:'main'})).toThrow('SOURCE_ASSOCIATION_REVIEW_REQUIRED');
  expect(()=>inspectSourceAssociationInventory(rows.slice(1),previous,review)).toThrow('SOURCE_ASSOCIATION_SOURCE_MISMATCH');
  expect(()=>inspectSourceAssociationInventory(rows.map((r,i)=>i?r:{...r,sql:r.sql+'\n'}),previous,review)).toThrow('SOURCE_ASSOCIATION_SOURCE_MISMATCH');
  expect(()=>inspectSourceAssociationInventory(rows,[...previous,{id:'110_unreviewed',checksum:'0'.repeat(64)}],review)).toThrow('SOURCE_ASSOCIATION_APPLIED_RECEIPTS_MISMATCH');
  expect(()=>inspectSourceAssociationInventory(rows,previous.map((r,i)=>i?r:{...r,checksum:'0'.repeat(64)}),review)).toThrow('SOURCE_ASSOCIATION_APPLIED_RECEIPTS_MISMATCH');
 });
});
