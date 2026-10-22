// Exact 088-092 migration boundary. No permissive future-schema acceptance.
// The CLI is supplied separately; these functions require an owner transaction.
import {createHash} from 'node:crypto';
export const BASELINE_DIGEST='6a6e6bdc2ba9494843b77bef1be46dedda92045481665b5c6a2c157177441bfa';
export const MIGRATIONS=Object.freeze([
 ['088_commit_safe_event_stream','2e0cc947a2e08f0f27f408a77894625f2683548491a19b267900fb091d1fa660'],
 ['089_partner_organizations','eb1b08da5232ff2d57bca31eaee940428eaabfacf8f4c29b95cd1001f4d2b502'],
 ['090_organization_command_results','15b4bd98631aabd80909f2ce43ac6c6b45d970ab3a0ee3def018af27d7370471'],
 ['091_organization_read_visibility','23932317aeaa63df421b5c8849e163f0b318904b0aec4a66f39b8a01fa317016'],
 ['092_organization_policy_recovery','d4f0c9555f28fd9009b90a3fc80ef782ea1244f2b4bdd07ba98d01ee956f40a4'],
].map(([id,checksum])=>Object.freeze({id,checksum})));
// All new tables permit reads and inserts. Updates are column-scoped; deletes,
// truncation, trigger management and changes to frozen associations stay denied.
export const TABLES=Object.freeze({
 api_event_stream_heads:['position'],api_event_stream:[],platform_organizations:['enabled'],
 platform_memberships:['revoked_at'],platform_principals:['revoked_at'],
 platform_credentials:['revoked_at','last_used_at'],platform_delegations:['revoked_at'],
 platform_integration_accounts:[],platform_proof_ownership:[],platform_external_bindings:[],
 platform_action_audit:[],platform_capture_authorizations:[],platform_webhook_authorizations:[],
 platform_command_results:['response'],
});
const permissions=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
const fail=code=>{throw Error(code);};
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest=value=>createHash('sha256').update(value).digest('hex');
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
const quote=name=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(name))fail('INVALID_DATABASE_IDENTIFIER');return '"'+name+'"';};
export function inspectInventory(inventory,applied){
 if(inventory.length!==91||new Set(inventory.map(r=>r.id)).size!==91)fail('CANDIDATE_INVENTORY_MISMATCH');
 if(inventory.some(r=>typeof r.sql!=='string'||bytesDigest(r.sql)!==r.checksum))fail('MIGRATION_BYTES_MISMATCH');
 for(const pin of MIGRATIONS)if(!inventory.some(r=>r.id===pin.id&&r.checksum===pin.checksum))fail('MIGRATION_BYTES_MISMATCH');
 const added=new Set(MIGRATIONS.map(r=>r.id));
 if(digest(entries(inventory.filter(r=>!added.has(r.id))))!==BASELINE_DIGEST)fail('BASELINE_INVENTORY_MISMATCH');
 if(![86,91].includes(applied.length)||new Set(applied.map(r=>r.id)).size!==applied.length)fail('APPLIED_INVENTORY_MISMATCH');
 const expected=new Map(inventory.map(r=>[r.id,r.checksum]));
 if(applied.some(r=>expected.get(r.id)!==r.checksum))fail('APPLIED_CHECKSUM_MISMATCH');
 if(digest(entries(applied.filter(r=>!added.has(r.id))))!==BASELINE_DIGEST)fail('BASELINE_RECEIPT_MISSING');
 return {pending:applied.length===86,appliedCount:applied.length,inventoryDigest:digest(entries(inventory)),appliedDigest:digest(entries(applied))};
}
export async function inspectState(db,inventory,runtime){
 quote(runtime);
 const state=inspectInventory(inventory,(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows);
 const names=Object.keys(TABLES).sort();
 const tables=(await db.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND (left(c.relname,9)='platform_' OR c.relname=ANY($1::text[])) ORDER BY c.relname",[names])).rows.map(r=>r.name);
 if(state.pending?tables.length>0:digest(tables)!==digest(names))fail('FOUNDATION_SCHEMA_MISMATCH');
 const role=(await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[runtime])).rows[0];
 if(!role||Object.values(role).some(Boolean))fail('RUNTIME_AUTHORITY_UNSAFE');
 const core=(await db.query("SELECT c.relname AS name,p.privilege,has_table_privilege($1,c.oid,p.privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($3::text[]) p(privilege) WHERE n.nspname=current_schema() AND c.relkind='r' AND NOT c.relname=ANY($2::text[]) ORDER BY c.relname,p.privilege",[runtime,names,permissions])).rows;
 const memberships=(await db.query("SELECT rolname FROM pg_roles WHERE pg_has_role($1,oid,'MEMBER') ORDER BY rolname",[runtime])).rows;
 const schema=(await db.query("SELECT has_schema_privilege($1,current_schema(),'USAGE') AS usage,has_schema_privilege($1,current_schema(),'CREATE') AS create",[runtime])).rows[0];
 if(schema.create)fail('RUNTIME_SCHEMA_AUTHORITY_UNSAFE');
 const manifests=(await db.query('SELECT proof_id,canonical_json,sha256,signature_algorithm,signature_base64,signing_key_id FROM final_manifests ORDER BY proof_id')).rows;
 if(manifests.some(r=>bytesDigest(r.canonical_json)!==r.sha256))fail('FROZEN_MANIFEST_HASH_MISMATCH');
 const evidence=(await db.query('SELECT id,proof_id,sha256,byte_size,object_key,object_version_id FROM evidence WHERE committed_at IS NOT NULL ORDER BY id')).rows;
 const frozen={manifestCount:manifests.length,manifestDigest:digest(manifests.map(({canonical_json,...row})=>row)),evidenceCount:evidence.length,evidenceDigest:digest(evidence)};
 const tablePrivileges=state.pending?[]:(await db.query("SELECT c.relname AS name,p.privilege,has_table_privilege($1,c.oid,p.privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($3::text[]) p(privilege) WHERE n.nspname=current_schema() AND c.relname=ANY($2::text[]) ORDER BY c.relname,p.privilege",[runtime,names,permissions])).rows;
 const columnPrivileges=state.pending?[]:(await db.query("SELECT c.relname AS name,a.attname AS column_name,has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum",[runtime,names])).rows;
 return {...state,tables,runtimeAuthorityDigest:digest({role,core,memberships,schema}),frozen,tablePrivileges,columnPrivileges};
}
export function assertMinimalPrivileges(state){
 if(state.tables.length!==Object.keys(TABLES).length||state.tablePrivileges.length!==Object.keys(TABLES).length*permissions.length)fail('FOUNDATION_PRIVILEGES_MISMATCH');
 for(const r of state.tablePrivileges)if(r.allowed!==['SELECT','INSERT'].includes(r.privilege))fail('FOUNDATION_PRIVILEGES_MISMATCH');
 for(const r of state.columnPrivileges)if(r.allowed!==TABLES[r.name].includes(r.column_name))fail('FOUNDATION_PRIVILEGES_MISMATCH');
}
export function inspectionReceipt(state,source,compatibleImage,now=new Date()){
 if(!/^[a-f0-9]{40}$/.test(source??''))fail('SOURCE_PIN_REQUIRED');
 if(!/^sha256:[a-f0-9]{64}$/.test(compatibleImage??''))fail('COMPATIBILITY_IMAGE_REQUIRED');
 const receipt={schema:'packproof.foundation-migration-inspection.v1',source,compatibleImage,inspectedAt:now.toISOString(),migrations:MIGRATIONS,state};
 return {...receipt,inspectionSha256:digest(receipt)};
}
export function validateInspection(receipt,state,source,compatibleImage,now=new Date()){
 const {inspectionSha256,...body}=receipt??{};
 if(inspectionSha256!==digest(body)||receipt.schema!=='packproof.foundation-migration-inspection.v1'||receipt.source!==source||receipt.compatibleImage!==compatibleImage||digest(receipt.migrations)!==digest(MIGRATIONS))fail('INSPECTION_BINDING_MISMATCH');
 const age=now.getTime()-Date.parse(receipt.inspectedAt);
 if(!Number.isFinite(age)||age<0||age>900000)fail('INSPECTION_EXPIRED');
 if(digest(receipt.state)!==digest(state))fail('INSPECTION_STATE_CHANGED');
}
export async function applyInTransaction(tx,inventory,receipt,{source,compatibleImage,runtime,splitSqlStatements,now=new Date()}){
 quote(runtime);
 await tx.query("SET LOCAL lock_timeout='5s'");await tx.query("SET LOCAL statement_timeout='30s'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
 await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
 await tx.query('LOCK TABLE schema_migrations,final_manifests,evidence IN SHARE ROW EXCLUSIVE MODE');
 const before=await inspectState(tx,inventory,runtime);validateInspection(receipt,before,source,compatibleImage,now);
 if(!before.pending){assertMinimalPrivileges(before);return {...before,alreadyApplied:true};}
 for(const pin of MIGRATIONS){
  const row=inventory.find(r=>r.id===pin.id);
  for(const statement of splitSqlStatements(row.sql))await tx.query(statement);
  await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[row.id,now.toISOString(),row.checksum]);
 }
 for(const [table,updates] of Object.entries(TABLES)){
  await tx.query(`REVOKE ALL PRIVILEGES ON TABLE ${quote(table)} FROM PUBLIC,${quote(runtime)}`);
  await tx.query(`GRANT SELECT,INSERT ON TABLE ${quote(table)} TO ${quote(runtime)}`);
  if(updates.length)await tx.query(`GRANT UPDATE(${updates.map(quote).join(',')}) ON TABLE ${quote(table)} TO ${quote(runtime)}`);
 }
 const after=await inspectState(tx,inventory,runtime);assertMinimalPrivileges(after);
 if(after.pending||after.runtimeAuthorityDigest!==before.runtimeAuthorityDigest||digest(after.frozen)!==digest(before.frozen))fail('FINAL_PRESERVATION_MISMATCH');
 return {...after,alreadyApplied:false};
}
