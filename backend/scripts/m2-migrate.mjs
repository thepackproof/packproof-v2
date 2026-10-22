// Exact inactive-schema 093-095 operator. Runtime grants and feature activation
// are separate operations. The retired 088-092 operator remains unchanged.
import {createHash} from 'node:crypto';
export const BASELINE_DIGEST='4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e';
export const MIGRATIONS=Object.freeze([
 ['093_integrity_envelope_jobs','6f4d3f3e3f52fd82816aa84fc74b70c60853b27ca155670359058741f6b84b9b'],
 ['094_claim_cases','e32f262ef9cba012d3bcd886476239f75876a148d3567a1e99ac76bad7f7658e'],
 ['095_recipient_export_preservation','1cecb6cdc12ef5ba89e0515599c8be7b875e99a4cf1a47eee2c4be08e9a25ce2'],
].map(([id,checksum])=>Object.freeze({id,checksum})));
export const NEW_TABLES=Object.freeze(['claim_case_revisions','claim_cases','integrity_envelope_delivery','integrity_envelope_jobs','integrity_envelope_results','recipient_export_preservations']);
export const FROZEN_TABLES=Object.freeze(['final_manifests','evidence','commerce_stages','commerce_stage_evidence','proof_supplements','signature_snapshots','signature_cases','signature_case_approvals','recipient_export_jobs','recipient_export_approvals']);
const fail=code=>{throw Error(code);};
const bytesDigest=value=>createHash('sha256').update(value).digest('hex');
export const digest=value=>bytesDigest(JSON.stringify(value));
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id,'en'));
const quote=name=>{if(typeof name!=='string'||! /^[a-z][a-z0-9_]{0,62}$/.test(name))fail('M2_IDENTIFIER_INVALID');return '"'+name+'"';};
const privileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
export function inspectInventory(inventory,applied){
 if(inventory.length!==94||new Set(inventory.map(r=>r.id)).size!==94)fail('M2_CANDIDATE_INVENTORY_MISMATCH');
 if(inventory.some(r=>typeof r.sql!=='string'||bytesDigest(r.sql)!==r.checksum))fail('M2_MIGRATION_BYTES_MISMATCH');
 for(const pin of MIGRATIONS)if(!inventory.some(r=>r.id===pin.id&&r.checksum===pin.checksum))fail('M2_MIGRATION_BYTES_MISMATCH');
 const additions=new Set(MIGRATIONS.map(r=>r.id));
 if(digest(entries(inventory.filter(r=>!additions.has(r.id))))!==BASELINE_DIGEST)fail('M2_BASELINE_INVENTORY_MISMATCH');
 if(![91,94].includes(applied.length)||new Set(applied.map(r=>r.id)).size!==applied.length)fail('M2_APPLIED_INVENTORY_MISMATCH');
 const expected=new Map(inventory.map(r=>[r.id,r.checksum]));
 if(applied.some(r=>expected.get(r.id)!==r.checksum))fail('M2_APPLIED_CHECKSUM_MISMATCH');
 if(digest(entries(applied.filter(r=>!additions.has(r.id))))!==BASELINE_DIGEST)fail('M2_BASELINE_RECEIPT_MISSING');
 return {pending:applied.length===91,appliedCount:applied.length,inventoryDigest:digest(entries(inventory)),appliedDigest:digest(entries(applied))};
}
/** The bridge is valid only before any organization/envelope/claim activation.
 * Existing legacy exports are preserved, but must have no queued worker writes. */
export async function inspectState(db,inventory,runtimeRoles){
 if(!Array.isArray(runtimeRoles)||!runtimeRoles.length||runtimeRoles.length>10||new Set(runtimeRoles).size!==runtimeRoles.length)fail('M2_RUNTIME_ROLES_REQUIRED');
 runtimeRoles.forEach(quote);
 const state=inspectInventory(inventory,(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows);
 const names=(await db.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname",[NEW_TABLES])).rows.map(r=>r.name);
 if(state.pending?names.length!==0:digest(names)!==digest(NEW_TABLES))fail('M2_SCHEMA_MISMATCH');
 if((await db.query('SELECT 1 FROM platform_organizations LIMIT 1')).rows.length)fail('M2_ORGANIZATION_ACTIVATION_PRESENT');
 if((await db.query("SELECT 1 FROM recipient_export_jobs WHERE state NOT IN ('READY','FAILED') LIMIT 1")).rows.length)fail('M2_RECIPIENT_WORK_IN_FLIGHT');
 for(const table of names)if((await db.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rows.length)fail('M2_ACTIVITY_PRESENT');
 const identities=(await db.query('SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[runtimeRoles])).rows;
 if(identities.length!==runtimeRoles.length||identities.some(({rolname,...flags})=>Object.values(flags).some(Boolean)))fail('M2_RUNTIME_AUTHORITY_UNSAFE');
 const authority=(await db.query(`SELECT r.role,c.relname,p.privilege,has_table_privilege(r.role,c.oid,p.privilege) AS allowed,
 has_table_privilege(r.role,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($1::text[]) r(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=current_schema() AND c.relkind='r' AND NOT c.relname=ANY($2::text[]) ORDER BY r.role,c.relname,p.privilege`,[runtimeRoles,NEW_TABLES,privileges])).rows;
 const columns=(await db.query(`SELECT r.role,c.relname,a.attname,p.privilege,has_column_privilege(r.role,c.oid,a.attnum,p.privilege) AS allowed,
 has_column_privilege(r.role,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest($1::text[]) r(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=current_schema() AND c.relkind='r' AND NOT c.relname=ANY($2::text[]) ORDER BY r.role,c.relname,a.attnum,p.privilege`,[runtimeRoles,NEW_TABLES,['SELECT','INSERT','UPDATE','REFERENCES']])).rows;
 const memberships=(await db.query("SELECT r.role,p.rolname FROM pg_roles p CROSS JOIN unnest($1::text[]) r(role) WHERE pg_has_role(r.role,p.oid,'MEMBER') ORDER BY r.role,p.rolname",[runtimeRoles])).rows;
 const schema=(await db.query("SELECT r.role,has_schema_privilege(r.role,current_schema(),'USAGE') AS usage,has_schema_privilege(r.role,current_schema(),'CREATE') AS create FROM unnest($1::text[]) r(role) ORDER BY r.role",[runtimeRoles])).rows;
 if(schema.some(r=>r.create))fail('M2_RUNTIME_SCHEMA_AUTHORITY_UNSAFE');
 const owners=(await db.query(`SELECT r.role FROM pg_class c CROSS JOIN unnest($1::text[]) r(role)
 WHERE c.relnamespace=current_schema()::regnamespace AND pg_has_role(r.role,c.relowner,'MEMBER') LIMIT 1`,[runtimeRoles])).rows;
 if(owners.length)fail('M2_RUNTIME_OWNER_AUTHORITY_UNSAFE');
 if(!state.pending){
  const requiredTriggers=['integrity_envelope_jobs_no_change','integrity_envelope_results_no_change','claim_cases_immutable','claim_case_revisions_immutable','recipient_export_preservation_immutable','platform_account_identity_immutable','recipient_export_job_immutable'];
  const triggers=(await db.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE c.relnamespace=current_schema()::regnamespace AND t.tgname=ANY($1::text[]) AND t.tgenabled='O' AND NOT t.tgisinternal ORDER BY t.tgname`,[requiredTriggers])).rows.map(r=>r.tgname);
  if(digest(triggers)!==digest(requiredTriggers.sort()))fail('M2_IMMUTABILITY_GUARDS_MISMATCH');
  const expectedBody=inventory.find(r=>r.id==='095_recipient_export_preservation').sql.split('$$')[1];
  const actualBody=(await db.query("SELECT prosrc FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='protect_recipient_export_job' AND pronargs=0")).rows;
  if(actualBody.length!==1||actualBody[0].prosrc!==expectedBody)fail('M2_IMMUTABILITY_GUARDS_MISMATCH');
  const constraints=(await db.query(`SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace
   AND conname=ANY($1::text[]) AND contype='u' AND convalidated ORDER BY conname`,[['platform_account_claim_identity','recipient_export_job_proof']])).rows;
  if(constraints.length!==2)fail('M2_ASSOCIATION_GUARDS_MISMATCH');
  // Any non-owner direct ACL, including PUBLIC or a broad inherited group,
  // means a separate activation step has occurred. Do not reapply over it.
  const active=(await db.query(`SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner LIMIT 1`,[NEW_TABLES])).rows;
  const activeColumns=(await db.query(`SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) p
   WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND p.grantee<>c.relowner LIMIT 1`,[NEW_TABLES])).rows;
  if(active.length||activeColumns.length)fail('M2_RUNTIME_GRANTS_PRESENT');
 }
 const manifests=(await db.query('SELECT canonical_json,sha256 FROM final_manifests')).rows;
 if(manifests.some(r=>bytesDigest(r.canonical_json)!==r.sha256))fail('M2_FROZEN_MANIFEST_HASH_MISMATCH');
 const frozen={};
 for(const table of FROZEN_TABLES){
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM ${quote(table)} t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
  if(rows.length>100000)fail('M2_INSPECTION_BOUND_EXCEEDED');
  frozen[table]={count:rows.length,sha256:digest(rows)};
 }
 return {...state,runtimeRoles:[...runtimeRoles].sort(),runtimeAuthorityDigest:digest({identities,authority,columns,memberships,schema}),frozen};
}
export function inspectionReceipt(state,{source,compatibleImage,compatibilityEvidenceSha256},now=new Date()){
 if(!/^[a-f0-9]{40}$/.test(source??''))fail('M2_SOURCE_PIN_REQUIRED');
 if(!/^sha256:[a-f0-9]{64}$/.test(compatibleImage??''))fail('M2_COMPATIBILITY_IMAGE_REQUIRED');
 if(!/^[a-f0-9]{64}$/.test(compatibilityEvidenceSha256??''))fail('M2_COMPATIBILITY_EVIDENCE_REQUIRED');
 const body={schema:'packproof.m2-migration-inspection.v1',source,compatibleImage,compatibilityEvidenceSha256,inspectedAt:now.toISOString(),migrations:MIGRATIONS,state};
 return {...body,inspectionSha256:digest(body)};
}
export function validateInspection(receipt,state,binding,now=new Date()){
 inspectionReceipt({},binding,now);
 const {inspectionSha256,...body}=receipt??{};
 if(inspectionSha256!==digest(body)||receipt.schema!=='packproof.m2-migration-inspection.v1'||Object.entries(binding).some(([k,v])=>receipt[k]!==v)||digest(receipt.migrations)!==digest(MIGRATIONS))fail('M2_INSPECTION_BINDING_MISMATCH');
 const age=now.getTime()-Date.parse(receipt.inspectedAt);
 if(!Number.isFinite(age)||age<0||age>900000)fail('M2_INSPECTION_EXPIRED');
 if(digest(receipt.state)!==digest(state))fail('M2_INSPECTION_STATE_CHANGED');
}
export async function applyInTransaction(tx,inventory,receipt,{source,compatibleImage,compatibilityEvidenceSha256,runtimeRoles,splitSqlStatements,now=new Date()}){
 const binding={source,compatibleImage,compatibilityEvidenceSha256};
 await tx.query("SET LOCAL lock_timeout='5s'");await tx.query("SET LOCAL statement_timeout='30s'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
 await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
 await tx.query(`LOCK TABLE schema_migrations,platform_organizations,platform_integration_accounts,${FROZEN_TABLES.map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
 const before=await inspectState(tx,inventory,runtimeRoles);validateInspection(receipt,before,binding,now);
 if(!before.pending)return {...before,alreadyApplied:true};
 for(const pin of MIGRATIONS){
  const row=inventory.find(r=>r.id===pin.id);
  for(const statement of splitSqlStatements(row.sql))await tx.query(statement);
  await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[row.id,now.toISOString(),row.checksum]);
 }
 // Remove inherited default ACLs only on the six newly created inactive tables.
 // Existing table/column grants, memberships and default ACL policies are untouched.
 const inherited=(await tx.query(`SELECT DISTINCT c.relname,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner ORDER BY c.relname,a.grantee`,[NEW_TABLES])).rows;
 for(const row of inherited)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE ${quote(row.relname)} FROM ${Number(row.grantee)===0?'PUBLIC':quote(row.rolname)}`);
 const after=await inspectState(tx,inventory,runtimeRoles);
 if(after.pending||after.runtimeAuthorityDigest!==before.runtimeAuthorityDigest||digest(after.frozen)!==digest(before.frozen))fail('M2_FINAL_PRESERVATION_MISMATCH');
 return {...after,alreadyApplied:false};
}
