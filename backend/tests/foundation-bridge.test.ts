import {beforeAll,describe,it,expect} from 'vitest';
import {migrationInventory,assertSchemaCurrent} from '../src/db/migrate.js';
const additions=[{"id":"088_commit_safe_event_stream","checksum":"2e0cc947a2e08f0f27f408a77894625f2683548491a19b267900fb091d1fa660"},{"id":"089_partner_organizations","checksum":"eb1b08da5232ff2d57bca31eaee940428eaabfacf8f4c29b95cd1001f4d2b502"},{"id":"090_organization_command_results","checksum":"15b4bd98631aabd80909f2ce43ac6c6b45d970ab3a0ee3def018af27d7370471"},{"id":"091_organization_read_visibility","checksum":"23932317aeaa63df421b5c8849e163f0b318904b0aec4a66f39b8a01fa317016"},{"id":"092_organization_policy_recovery","checksum":"d4f0c9555f28fd9009b90a3fc80ef782ea1244f2b4bdd07ba98d01ee956f40a4"}];
let base:Awaited<ReturnType<typeof migrationInventory>>;
beforeAll(async()=>{base=await migrationInventory();});
const db=(rows:unknown[],active=false)=>({query:async(sql:string)=>({rows:sql.startsWith('SELECT id,checksum')?rows:active?[{exists:true}]:[],rowCount:0})});
describe('temporary foundation rollback boundary',()=>{
 it('admits the unchanged production schema and the exact unactivated foundation',async()=>{
  await expect(assertSchemaCurrent(db(base) as any)).resolves.toBeUndefined();
  await expect(assertSchemaCurrent(db([...base,...additions]) as any)).resolves.toBeUndefined();
 });
 it('refuses incomplete, tampered and unknown future receipts',async()=>{
  await expect(assertSchemaCurrent(db([...base,additions[0]]) as any)).rejects.toThrow('Partial foundation');
  await expect(assertSchemaCurrent(db([...base,...additions.map((r,i)=>i?r:{...r,checksum:'f'.repeat(64)})]) as any)).rejects.toThrow('compatibility envelope');
  await expect(assertSchemaCurrent(db([...base,{id:'999_future',checksum:'f'.repeat(64)}]) as any)).rejects.toThrow('compatibility envelope');
 });
 it('refuses rollback after organization activation',async()=>{
  await expect(assertSchemaCurrent(db([...base,...additions],true) as any)).rejects.toThrow('organization-aware');
 });
});
