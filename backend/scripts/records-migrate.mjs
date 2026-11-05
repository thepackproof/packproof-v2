// Exact 095 -> 107 inactive-schema upgrade. This operator never starts the API,
// provisions credentials, activates organizations, or deletes evidence.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const manifest=JSON.parse(readFileSync(new URL('./records-migration-manifest.json',import.meta.url),'utf8'));
export const MIGRATIONS=Object.freeze(manifest.additions.map(row=>Object.freeze(row)));
export const BASELINE_DIGEST=manifest.baselineSha256;
export const INVENTORY_DIGEST=manifest.inventorySha256;
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error(code);};
const quote=name=>{if(typeof name!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(name))fail('RECORDS_IDENTIFIER_INVALID');return '"'+name+'"';};
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
const additions=new Set(MIGRATIONS.map(row=>row.id));
const policyAdditions=['record_locations','record_membership_locations','record_state','record_snapshot_shares','record_requirement_templates'];
const bridgeReads=['record_membership_locations','record_state'];

export function inspectInventory(inventory,applied){
 if(inventory.length!==106||new Set(inventory.map(r=>r.id)).size!==106||digest(entries(inventory))!==INVENTORY_DIGEST)fail('RECORDS_CANDIDATE_INVENTORY_MISMATCH');
 if(inventory.some(r=>typeof r.sql!=='string'||bytes(r.sql)!==r.checksum))fail('RECORDS_MIGRATION_BYTES_MISMATCH');
 if(digest(entries(inventory.filter(r=>!additions.has(r.id))))!==BASELINE_DIGEST)fail('RECORDS_BASELINE_INVENTORY_MISMATCH');
 if(![94,106].includes(applied.length)||new Set(applied.map(r=>r.id)).size!==applied.length)fail('RECORDS_APPLIED_INVENTORY_MISMATCH');
 const expected=new Map(inventory.map(row=>[row.id,row.checksum]));
 if(applied.some(row=>expected.get(row.id)!==row.checksum))fail('RECORDS_APPLIED_CHECKSUM_MISMATCH');
 if(digest(entries(applied.filter(row=>!additions.has(row.id))))!==BASELINE_DIGEST)fail('RECORDS_BASELINE_RECEIPT_MISSING');
 return {pending:applied.length===94,appliedCount:applied.length,inventorySha256:INVENTORY_DIGEST,appliedSha256:digest(entries(applied))};
}

function schemaChanges(inventory){
 const sql=inventory.filter(row=>additions.has(row.id)).map(row=>row.sql).join('\n');
 const tables=[...sql.matchAll(/CREATE TABLE ([a-z][a-z0-9_]*)\s*\(/g)].map(m=>m[1]).sort();
 const functions=[...sql.matchAll(/CREATE FUNCTION ([a-z][a-z0-9_]*)\s*\(/g)].map(m=>m[1]);
 if(tables.length!==37||new Set(tables).size!==tables.length||!functions.includes('platform_operator_access_active'))fail('RECORDS_SCHEMA_SOURCE_MISMATCH');
 return {tables,functions,sql};
}

async function verifyNewGuards(db,changes){
 const expected=[...changes.sql.matchAll(/CREATE TRIGGER ([a-z][a-z0-9_]*) (BEFORE|AFTER) ([^;]+?) ON ([a-z][a-z0-9_]*)\s+FOR EACH ROW EXECUTE FUNCTION ([a-z][a-z0-9_]*)\(\)/g)]
  .map(m=>({name:m[1],table:m[4],function:m[5],type:1+(m[2]==='BEFORE'?2:0)+(/INSERT/.test(m[3])?4:0)+(/DELETE/.test(m[3])?8:0)+(/UPDATE/.test(m[3])?16:0)})).sort((a,b)=>a.name<b.name?-1:1);
 const actual=(await db.query(`SELECT t.tgname AS name,c.relname AS table,p.proname AS function,t.tgtype AS type,t.tgenabled AS enabled,t.tgnargs AS arguments,t.tgqual::text AS condition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY t.tgname`,[changes.tables])).rows;
 if(!expected.length||actual.some(row=>row.enabled!=='O'||Number(row.arguments)!==0||row.condition!==null)||digest(actual.map(({name,table,function:fn,type})=>({name,table,function:fn,type:Number(type)})))!==digest(expected))fail('RECORDS_IMMUTABILITY_GUARDS_MISMATCH');
 const bodies=[...changes.sql.matchAll(/CREATE FUNCTION ([a-z][a-z0-9_]*)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g)].map(m=>({name:m[1],body:m[2],definer:/SECURITY DEFINER/.test(m[0])}));
 const observed=(await db.query(`SELECT proname AS name,prosrc AS body,prosecdef AS definer FROM pg_proc
 WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`,[changes.functions])).rows;
 if(bodies.length!==changes.functions.length||digest(observed)!==digest(bodies.sort((a,b)=>a.name<b.name?-1:1)))fail('RECORDS_FUNCTION_GUARDS_MISMATCH');
 const sequenceAcl=(await db.query(`SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace=current_schema()::regnamespace AND c.relname='record_issue_actions_sequence_seq' AND a.grantee<>c.relowner LIMIT 1`)).rows;
 if(sequenceAcl.length)fail('RECORDS_INACTIVE_PRIVILEGES_MISMATCH');
 const publicLock=(await db.query(`SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.pronamespace=current_schema()::regnamespace AND p.proname='lock_operational_snapshot_authority' AND a.grantee=0 LIMIT 1`)).rows;
 if(publicLock.length)fail('RECORDS_INACTIVE_PRIVILEGES_MISMATCH');
 const recovery=(await db.query('SELECT table_name,key_columns FROM policy_recovery_tables WHERE table_name=ANY($1::text[]) ORDER BY table_name',[policyAdditions])).rows;
 const expectedRecovery=[{table_name:'record_locations',key_columns:['id','organization_id']},{table_name:'record_membership_locations',key_columns:['membership_id','location_id']},{table_name:'record_requirement_templates',key_columns:['template_id','version']},{table_name:'record_snapshot_shares',key_columns:['id']},{table_name:'record_state',key_columns:['proof_id']}];
 if(digest(recovery)!==digest(expectedRecovery))fail('RECORDS_RECOVERY_CATALOG_MISMATCH');
}

async function baselineSnapshot(db,changes,runtimeRole){
 // Project historical columns explicitly: the two reviewed additive columns
 // must not change the digest of already preserved rows.
 const columns=(await db.query(`SELECT c.relname AS name,a.attname AS column_name,c.relacl::text AS acl,a.attacl::text AS column_acl
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($1::text[])
 ORDER BY c.relname,a.attnum`,[changes.tables])).rows.filter(row=>!(row.name==='platform_memberships'&&row.column_name==='location_scoped')&&!(row.name==='platform_proof_ownership'&&row.column_name==='origin_user_id'));
 const tables=[...new Set(columns.map(row=>row.name))],frozen={};
 for(const table of tables){
  if(table==='schema_migrations')continue;
  const fields=columns.filter(row=>row.name===table).map(row=>quote(row.column_name)).join(',');
  const where=table==='policy_recovery_tables'?' WHERE NOT table_name=ANY($1::text[])':'';
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM ${quote(table)}${where}) t ORDER BY to_jsonb(t)::text LIMIT 100001`,table==='policy_recovery_tables'?[policyAdditions]:[])).rows;
  if(rows.length>100000)fail('RECORDS_INSPECTION_BOUND_EXCEEDED');
  frozen[table]={count:rows.length,sha256:digest(rows)};
 }
 const functions=(await db.query(`SELECT p.oid,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,p.proparallel,p.prorettype,p.proargtypes::text AS arguments,p.proacl::text AS acl
 FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace ORDER BY p.oid`)).rows
  .filter(row=>!changes.functions.includes(row.proname))
  .map(row=>({...row,proname:row.proname==='pre_records_operator_access_active'?'platform_operator_access_active':row.proname}));
 // The old operator function is renamed, retaining its body, OID and ACL. The
 // replacement function is reviewed separately with the new schema.
 const original=(await db.query(`SELECT p.oid,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,p.proparallel,p.prorettype,p.proargtypes::text AS arguments,p.proacl::text AS acl
 FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname='platform_operator_access_active'`)).rows;
 if(!functions.some(row=>row.proname==='platform_operator_access_active'))functions.push(...original);
 functions.sort((a,b)=>Number(a.oid)-Number(b.oid));
 const triggers=(await db.query(`SELECT t.oid,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relnamespace=current_schema()::regnamespace AND NOT c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY t.oid`,[changes.tables])).rows;
 const role=(await db.query('SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[runtimeRole])).rows;
 if(role.length!==1||['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some(key=>role[0][key]))fail('RECORDS_BRIDGE_ROLE_UNSAFE');
 const memberships=(await db.query("SELECT p.rolname FROM pg_roles p WHERE pg_has_role($1,p.oid,'MEMBER') ORDER BY p.rolname",[runtimeRole])).rows;
 const schema=(await db.query("SELECT has_schema_privilege($1,current_schema(),'USAGE') AS usage,has_schema_privilege($1,current_schema(),'CREATE') AS create",[runtimeRole])).rows[0];
 if(!schema?.usage||schema.create)fail('RECORDS_BRIDGE_ROLE_UNSAFE');
 const owners=(await db.query(`SELECT 1 FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND pg_has_role($1,c.relowner,'MEMBER') LIMIT 1`,[runtimeRole])).rows;
 if(owners.length)fail('RECORDS_BRIDGE_ROLE_UNSAFE');
 const sequences=(await db.query("SELECT relname,relowner,relacl::text AS acl FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='S' AND relname<>'record_issue_actions_sequence_seq' ORDER BY relname")).rows;
 const defaults=(await db.query('SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text AS acl FROM pg_default_acl WHERE defaclnamespace=current_schema()::regnamespace ORDER BY defaclrole,defaclobjtype')).rows;
 return {tables,baselineDataSha256:digest(frozen),baselineCatalogSha256:digest({columns,functions,triggers,sequences,defaults}),baselineAuthoritySha256:digest({role,memberships,schema})};
}

export async function inspectState(db,inventory,runtimeRole){
 quote(runtimeRole);
 const state=inspectInventory(inventory,(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows);
 const changes=schemaChanges(inventory);
 const names=(await db.query("SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r' AND relname=ANY($1::text[]) ORDER BY relname",[changes.tables])).rows.map(row=>row.name);
 if(state.pending?names.length!==0:digest(names)!==digest(changes.tables))fail('RECORDS_SCHEMA_MISMATCH');
 if((await db.query('SELECT 1 FROM platform_organizations LIMIT 1')).rows.length)fail('RECORDS_ORGANIZATION_ACTIVATION_PRESENT');
 // No worker may change historical export bytes while the bridge is qualified.
 if((await db.query("SELECT 1 FROM recipient_export_jobs WHERE state NOT IN ('READY','FAILED') LIMIT 1")).rows.length)fail('RECORDS_RECIPIENT_WORK_IN_FLIGHT');
 for(const table of names)if((await db.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rows.length)fail('RECORDS_ACTIVITY_PRESENT');
 const manifests=(await db.query('SELECT canonical_json,sha256 FROM final_manifests LIMIT 100001')).rows;
 if(manifests.length>100000)fail('RECORDS_INSPECTION_BOUND_EXCEEDED');
 if(manifests.some(row=>bytes(row.canonical_json)!==row.sha256))fail('RECORDS_FROZEN_MANIFEST_HASH_MISMATCH');
 const baseline=await baselineSnapshot(db,changes,runtimeRole);
 if(!state.pending){
  const acl=(await db.query(`SELECT c.relname,a.grantee,a.privilege_type,a.is_grantable,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner ORDER BY c.relname,a.grantee,a.privilege_type`,[changes.tables])).rows;
  if(acl.length!==2||acl.some(row=>!bridgeReads.includes(row.relname)||row.rolname!==runtimeRole||row.privilege_type!=='SELECT'||row.is_grantable))fail('RECORDS_INACTIVE_PRIVILEGES_MISMATCH');
  const columnAcl=(await db.query(`SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) p
   WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND p.grantee<>c.relowner LIMIT 1`,[changes.tables])).rows;
  if(columnAcl.length)fail('RECORDS_INACTIVE_PRIVILEGES_MISMATCH');
  await verifyNewGuards(db,changes);
 }
 return {...state,runtimeRole,...baseline};
}

export function inspectionReceipt(state,binding,now=new Date()){
 const {source,compatibleImage,compatibilityEvidenceSha256,rehearsalSha256}=binding??{};
 if(!/^[a-f0-9]{40}$/.test(source??'')||!/^sha256:[a-f0-9]{64}$/.test(compatibleImage??'')||![compatibilityEvidenceSha256,rehearsalSha256].every(v=>/^[a-f0-9]{64}$/.test(v??'')))fail('RECORDS_QUALIFIED_RELEASE_BINDING_REQUIRED');
 const body={schema:'packproof.records-migration-inspection/v1',...binding,inspectedAt:now.toISOString(),migrations:MIGRATIONS,state};
 return {...body,inspectionSha256:digest(body)};
}

export function validateInspection(receipt,state,binding,now=new Date()){
 inspectionReceipt({},binding,now);
 const {inspectionSha256,...body}=receipt??{};
 if(inspectionSha256!==digest(body)||receipt.schema!=='packproof.records-migration-inspection/v1'||Object.entries(binding).some(([k,v])=>receipt[k]!==v)||digest(receipt.migrations)!==digest(MIGRATIONS))fail('RECORDS_INSPECTION_BINDING_MISMATCH');
 const age=now.getTime()-Date.parse(receipt.inspectedAt);
 if(!Number.isFinite(age)||age<0||age>900000)fail('RECORDS_INSPECTION_EXPIRED');
 if(digest(receipt.state)!==digest(state))fail('RECORDS_INSPECTION_STATE_CHANGED');
}

export async function applyInTransaction(tx,inventory,receipt,{runtimeRole,splitSqlStatements,now=new Date(),...binding}){
 await tx.query("SET LOCAL lock_timeout='5s'");await tx.query("SET LOCAL statement_timeout='30s'");
 await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
 await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
 const changes=schemaChanges(inventory);
 const tables=(await tx.query("SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r' ORDER BY relname")).rows.map(row=>row.name);
 await tx.query(`LOCK TABLE ${tables.map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
 const before=await inspectState(tx,inventory,runtimeRole);validateInspection(receipt,before,binding,now);
 if(!before.pending)return {...before,alreadyApplied:true};
 for(const pin of MIGRATIONS){
  const row=inventory.find(item=>item.id===pin.id);
  for(const statement of splitSqlStatements(row.sql))await tx.query(statement);
  await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[row.id,now.toISOString(),row.checksum]);
 }
 // Remove only defaults copied onto newly created objects. Existing ACLs and
 // default privilege policies remain byte-for-byte unchanged.
 const objects=[...changes.tables,'record_issue_actions_sequence_seq'];
 const acl=(await tx.query(`SELECT DISTINCT c.relname,c.relkind,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner ORDER BY c.relname,a.grantee`,[objects])).rows;
 for(const row of acl)await tx.query(`REVOKE ALL PRIVILEGES ON ${row.relkind==='S'?'SEQUENCE':'TABLE'} ${quote(row.relname)} FROM ${Number(row.grantee)===0?'PUBLIC':quote(row.rolname)}`);
 // The legacy operator predicate now references these two new, empty tables.
 // Read access preserves the bridge; it conveys no record-writing authority.
 for(const table of bridgeReads)await tx.query(`GRANT SELECT ON ${quote(table)} TO ${quote(runtimeRole)}`);
 const after=await inspectState(tx,inventory,runtimeRole);
 for(const field of ['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'])if(after[field]!==before[field])fail('RECORDS_FINAL_PRESERVATION_MISMATCH');
 if(after.pending)fail('RECORDS_FINAL_PRESERVATION_MISMATCH');
 return {...after,alreadyApplied:false};
}
