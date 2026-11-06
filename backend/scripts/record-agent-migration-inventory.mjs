// Read-only preparation for the additive Windows Connect schema. Historical
// 096-107 bridge/release operators stay pinned to their measured predecessor.
// This module neither applies SQL nor changes production roles or capabilities.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
const manifest=JSON.parse(readFileSync(new URL('./record-agent-migration-manifest.json',import.meta.url),'utf8'));

/** Exact-source preparation only. A successful result is not permission or
 * evidence to apply a production migration; the release operator must qualify
 * rollback compatibility and execute the reviewed migration separately. */
export function inspectAgentMigrationInventory(inventory,applied,{reviewedSourceCommit,reviewedInventorySha256}={}){
 if(!/^[a-f0-9]{40}$/.test(reviewedSourceCommit??'')||reviewedInventorySha256!==manifest.inventorySha256)fail('AGENT_REVIEWED_RELEASE_BINDING_REQUIRED');
 if(manifest.schema!=='packproof.record-agent-migration-manifest/v1'||manifest.additions?.length!==1||manifest.additions[0].id!=='108_record_agents')fail('AGENT_MIGRATION_MANIFEST_INVALID');
 if(inventory.length!==manifest.sourceCount||new Set(inventory.map(row=>row.id)).size!==inventory.length||sha(entries(inventory))!==manifest.inventorySha256)fail('AGENT_SOURCE_INVENTORY_MISMATCH');
 if(inventory.some(row=>typeof row.sql!=='string'||sha(row.sql)!==row.checksum))fail('AGENT_SOURCE_BYTES_MISMATCH');
 const additions=new Map(manifest.additions.map(row=>[row.id,row.checksum]));
 if(manifest.additions.some(pin=>inventory.find(row=>row.id===pin.id)?.checksum!==pin.checksum))fail('AGENT_SOURCE_ADDITION_MISMATCH');
 const predecessor=inventory.filter(row=>!additions.has(row.id));
 if(sha(entries(predecessor))!==manifest.predecessorInventorySha256)fail('AGENT_PREDECESSOR_INVENTORY_MISMATCH');
 if(![predecessor.length,inventory.length].includes(applied.length)||new Set(applied.map(row=>row.id)).size!==applied.length)fail('AGENT_APPLIED_INVENTORY_MISMATCH');
 const expected=new Map(inventory.map(row=>[row.id,row.checksum]));
 if(applied.some(row=>expected.get(row.id)!==row.checksum)||sha(entries(applied.filter(row=>!additions.has(row.id))))!==manifest.predecessorInventorySha256)fail('AGENT_APPLIED_RECEIPTS_MISMATCH');
 return {schema:'packproof.record-agent-schema-preparation/v1',sourceCommit:reviewedSourceCommit,sourceCount:inventory.length,appliedCount:applied.length,
  inventorySha256:manifest.inventorySha256,predecessorInventorySha256:manifest.predecessorInventorySha256,pending:applied.length!==inventory.length,
  additions:manifest.additions.map(row=>({...row})),migrationApplied:false,rolesChanged:false,featureActivation:false};
}
