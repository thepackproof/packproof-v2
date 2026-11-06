import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {migrationInventory} from '../src/db/migrate.js';
import {inspectAgentMigrationInventory} from '../scripts/record-agent-migration-inventory.mjs';

describe('Windows Connect additive schema preparation',()=>{
 it('pins source SQL and exact predecessor receipts without changing historical release manifests',async()=>{
  const inventory=await migrationInventory();
  const manifest=JSON.parse(await readFile(new URL('../scripts/record-agent-migration-manifest.json',import.meta.url),'utf8'));
  const historical=JSON.parse(await readFile(new URL('../scripts/records-migration-manifest.json',import.meta.url),'utf8'));
  const options={reviewedSourceCommit:'a'.repeat(40),reviewedInventorySha256:manifest.inventorySha256};
  const predecessor=inventory.filter(row=>row.id!=='108_record_agents');
  expect(manifest.predecessorInventorySha256).toBe(historical.inventorySha256);
  expect(historical.sourceCount).toBe(106);
  expect(historical.additions.at(-1).id).toBe('107_record_issue_assignments');
  const prepared=inspectAgentMigrationInventory(inventory,predecessor,options);
  expect(prepared).toMatchObject({pending:true,sourceCount:107,appliedCount:106,migrationApplied:false,rolesChanged:false,featureActivation:false});
  expect(prepared.additions.map(row=>row.id)).toEqual(['108_record_agents']);
  expect(inspectAgentMigrationInventory(inventory,inventory,options).pending).toBe(false);
  expect(()=>inspectAgentMigrationInventory(inventory,predecessor,{...options,reviewedSourceCommit:''})).toThrow('AGENT_REVIEWED_RELEASE_BINDING_REQUIRED');
  expect(()=>inspectAgentMigrationInventory(inventory,predecessor,{...options,reviewedInventorySha256:'0'.repeat(64)})).toThrow('AGENT_REVIEWED_RELEASE_BINDING_REQUIRED');
  expect(()=>inspectAgentMigrationInventory(inventory.slice(1),predecessor,options)).toThrow('AGENT_SOURCE_INVENTORY_MISMATCH');
  expect(()=>inspectAgentMigrationInventory(inventory.map(row=>row.id==='108_record_agents'?{...row,sql:row.sql+'\n'}:row),predecessor,options)).toThrow('AGENT_SOURCE_BYTES_MISMATCH');
  expect(()=>inspectAgentMigrationInventory(inventory,[...predecessor.slice(1),predecessor[0],predecessor[0]],options)).toThrow('AGENT_APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectAgentMigrationInventory(inventory,predecessor.map((row,index)=>index?row:{...row,checksum:'0'.repeat(64)}),options)).toThrow('AGENT_APPLIED_RECEIPTS_MISMATCH');
  expect(()=>inspectAgentMigrationInventory(inventory,[...predecessor,{id:'109_unreviewed',checksum:'0'.repeat(64)}],options)).toThrow('AGENT_APPLIED_RECEIPTS_MISMATCH');
 });
});
