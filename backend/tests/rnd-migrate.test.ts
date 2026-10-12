import { beforeAll,describe,expect,it,vi } from 'vitest';
import { migrationInventory } from '../src/db/migrate.js';
import { splitSqlStatements } from '../src/db/sql.js';
import { MIGRATIONS,BASELINE_DIGEST,PRODUCTION_RUNTIME_ROLE,RECEIPT_TABLES,digest,inspectInventory,inspectionReceipt,validateInspection,assertMinimalPrivileges,applyInTransaction,expectedObjects,run } from '../scripts/rnd-migrate.mjs';

let inventory:Awaited<ReturnType<typeof migrationInventory>>;
beforeAll(async()=>{inventory=await migrationInventory();});
const source='a'.repeat(40),bridge='sha256:'+'b'.repeat(64),now=new Date('2026-10-12T00:00:00Z');
const baseline=()=>inventory.filter(row=>!MIGRATIONS.some(pin=>pin.id===row.id)).map(({id,checksum})=>({id,checksum}));
describe('scoped research schema operator',()=>{
 it('binds exactly the existing 77 receipts and all nine reviewed SQL byte hashes',()=>{
  expect(inspectInventory(inventory,baseline())).toMatchObject({pending:true,appliedCount:77});
  expect(digest(baseline())).toBe(BASELINE_DIGEST);
  expect(inspectInventory(inventory,inventory)).toMatchObject({pending:false,appliedCount:86});
  expect(expectedObjects(inventory).tables).toHaveLength(25);
  expect(RECEIPT_TABLES).toHaveLength(7);
  expect(PRODUCTION_RUNTIME_ROLE).toBe('packproof_app_runtime_v1');
 });
 it('rejects changed source bytes, unknown future receipts, partial application and baseline drift',()=>{
  expect(()=>inspectInventory(inventory.map((row,index)=>index?row:{...row,sql:row.sql+'\n'}),baseline())).toThrow('MIGRATION_BYTES_MISMATCH');
  expect(()=>inspectInventory(inventory,[...baseline(),{id:'unexpected',checksum:'f'.repeat(64)}])).toThrow('APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory,[...baseline(),MIGRATIONS[0]])).toThrow('APPLIED_INVENTORY_MISMATCH');
  expect(()=>inspectInventory(inventory,baseline().map((row,index)=>index?row:{...row,checksum:'f'.repeat(64)}))).toThrow('APPLIED_CHECKSUM_MISMATCH');
 });
 it('requires an intact fresh inspection bound to state, exact source and compatible bridge image',()=>{
  const state=inspectInventory(inventory,baseline()),receipt=inspectionReceipt(state,source,bridge,now);
  expect(()=>validateInspection(receipt,state,source,bridge,now)).not.toThrow();
  expect(()=>validateInspection({...receipt,source:'f'.repeat(40)},state,source,bridge,now)).toThrow('INSPECTION_BINDING_MISMATCH');
  expect(()=>validateInspection(receipt,state,'c'.repeat(40),bridge,now)).toThrow('INSPECTION_BINDING_MISMATCH');
  expect(()=>validateInspection(receipt,{...state,appliedCount:86},source,bridge,now)).toThrow('INSPECTION_STATE_CHANGED');
  expect(()=>validateInspection(receipt,state,source,bridge,new Date(now.getTime()+900001))).toThrow('INSPECTION_EXPIRED');
  expect(()=>validateInspection(receipt,state,source,bridge,new Date(now.getTime()-1))).toThrow('INSPECTION_EXPIRED');
  expect(()=>inspectionReceipt(state,source,'latest',now)).toThrow('COMPATIBILITY_IMAGE_REQUIRED');
 });
 it('cannot declare broad or inherited runtime privileges minimal',()=>{
  const tables=expectedObjects(inventory).tables,privileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  const rows=tables.flatMap(name=>privileges.map(privilege=>({name,privilege,allowed:RECEIPT_TABLES.includes(name)&&['SELECT','INSERT'].includes(privilege)})));
  expect(()=>assertMinimalPrivileges({tables,rndPrivileges:rows})).not.toThrow();
  for(const target of [{name:'rnd_sources',privilege:'UPDATE'},{name:'rnd_analyses',privilege:'SELECT'}])expect(()=>assertMinimalPrivileges({tables,rndPrivileges:rows.map(row=>row.name===target.name&&row.privilege===target.privilege?{...row,allowed:true}:row)})).toThrow('RUNTIME_RND_PRIVILEGES_MISMATCH');
 });
 it('does not run any DDL when fresh inventory inspection differs',async()=>{
  const query=vi.fn(async(sql:string)=>{if(sql.startsWith('SELECT id,checksum'))return {rows:[...baseline(),MIGRATIONS[0]],rowCount:78};return {rows:[],rowCount:0};});
  await expect(applyInTransaction({query},inventory,{}, {source,compatibleImage:bridge,splitSqlStatements,now})).rejects.toThrow('APPLIED_INVENTORY_MISMATCH');
  expect(query.mock.calls.every(([sql])=>!/^(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
 });
 it('rejects missing operator identity or inspection before creating any connection',async()=>{
  await expect(run('--apply',{})).rejects.toThrow('EXPLICIT_OWNER_OPERATOR_REQUIRED');
  await expect(run('--apply',{PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'synthetic',PACKPROOF_RELEASE_SHA:source,PACKPROOF_COMPATIBILITY_IMAGE_DIGEST:bridge})).rejects.toThrow('INSPECTION_REQUIRED');
 });
});
