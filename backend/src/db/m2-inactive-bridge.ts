import {createHash} from 'node:crypto';
import type {Database} from './database.js';

/** Only the released 91-migration foundation application may use this bridge.
 * This admits an inactive additive schema, not M2 features or migration writes.
 */
export const M2_BRIDGE_PARENT = '99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9';
const BASELINE_DIGEST = '4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e';
export const M2_BRIDGE_MIGRATIONS = Object.freeze([
  {id:'093_integrity_envelope_jobs',checksum:'6f4d3f3e3f52fd82816aa84fc74b70c60853b27ca155670359058741f6b84b9b'},
  {id:'094_claim_cases',checksum:'e32f262ef9cba012d3bcd886476239f75876a148d3567a1e99ac76bad7f7658e'},
  {id:'095_recipient_export_preservation',checksum:'1cecb6cdc12ef5ba89e0515599c8be7b875e99a4cf1a47eee2c4be08e9a25ce2'},
].map(row=>Object.freeze(row)));
const TABLES = ['claim_case_revisions','claim_cases','integrity_envelope_delivery','integrity_envelope_jobs','integrity_envelope_results','recipient_export_preservations'];
const TRIGGERS = ['claim_case_revisions_immutable','claim_cases_immutable','integrity_envelope_jobs_no_change','integrity_envelope_results_no_change','platform_account_identity_immutable','recipient_export_job_immutable','recipient_export_preservation_immutable'].sort();
const sha = (text:string) => createHash('sha256').update(text).digest('hex');
const fail = (code:string):never => {throw new Error(code);};
type Receipt = {id:string;checksum:string|null};

export function isM2BridgeReceipt(row:Receipt):boolean {
  return M2_BRIDGE_MIGRATIONS.some(pin=>pin.id===row.id && pin.checksum===row.checksum);
}

/** Called at startup AND readiness. Catalog ACL checks require no new-table
 * SELECT grants. Production apply separately proves all six tables empty.
 * Any non-owner ACL is an activation boundary, even for another runtime role.
 * Owner-only changes remain an operational control, not something this reader
 * claims to inspect. Do not use this image after M2 activation or owner seeding.
 */
export async function assertInactiveM2Bridge(db:Database,applied:Receipt[],env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const futureIds = new Set(M2_BRIDGE_MIGRATIONS.map(r=>r.id));
  const future = applied.filter(r=>futureIds.has(r.id));
  // Preserve the released application's behavior on its own 91-receipt schema.
  // The ordinary migration verifier still rejects missing/changed baseline SQL.
  if(!future.length)return;
  for(const name of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_CLAIM_EXPORTS_ENABLED']) {
    if(env[name]!==undefined && env[name]!=='false')fail('M2_BRIDGE_FEATURE_ACTIVATION_FORBIDDEN');
  }
  if(applied.length!==94 || new Set(applied.map(r=>r.id)).size!==applied.length || future.length!==3)fail('M2_BRIDGE_PARTIAL_OR_UNKNOWN_SCHEMA');
  const baseline = applied.filter(r=>!futureIds.has(r.id)).map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  if(sha(JSON.stringify(baseline))!==BASELINE_DIGEST || future.some(r=>!isM2BridgeReceipt(r)))fail('M2_BRIDGE_RECEIPT_MISMATCH');
  const authority = (await db.query<{unsafe:boolean}>(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user,current_schema(),'CREATE')
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND pg_has_role(current_user,c.relowner,'MEMBER')) AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`)).rows;
  if(authority.length!==1 || authority[0].unsafe)fail('M2_BRIDGE_OWNER_OR_DDL_AUTHORITY_FORBIDDEN');
  if((await db.query('SELECT 1 FROM platform_organizations LIMIT 1')).rows.length)fail('M2_BRIDGE_ORGANIZATION_ACTIVATION_PRESENT');
  const tables = (await db.query<{name:string}>('SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind=\'r\' AND relname=ANY($1::text[]) ORDER BY relname',[TABLES])).rows.map(r=>r.name);
  if(JSON.stringify(tables)!==JSON.stringify(TABLES))fail('M2_BRIDGE_SCHEMA_SHAPE_MISMATCH');
  const granted = (await db.query(`SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner
    UNION ALL
    SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) p
    WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND p.grantee<>c.relowner LIMIT 1`,[TABLES])).rows;
  if(granted.length)fail('M2_BRIDGE_RUNTIME_ACTIVATION_PRESENT');
  const triggers = (await db.query<{name:string}>(`SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace=current_schema()::regnamespace AND t.tgname=ANY($1::text[]) AND t.tgenabled='O' AND NOT t.tgisinternal ORDER BY t.tgname`,[TRIGGERS])).rows.map(r=>r.name);
  if(JSON.stringify(triggers)!==JSON.stringify(TRIGGERS))fail('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
  const body = (await db.query<{prosrc:string}>("SELECT prosrc FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='protect_recipient_export_job' AND pronargs=0")).rows;
  if(body.length!==1 || sha(body[0].prosrc)!=='645fd5ab1411c8e4242eb957fcf4a2e88ea1582f7f49f614533159f73f297676')fail('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
  const constraints=(await db.query(`SELECT conname FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[]) AND contype='u' AND convalidated`,[['platform_account_claim_identity','recipient_export_job_proof']])).rows;
  if(constraints.length!==2)fail('M2_BRIDGE_PROTECTION_GUARDS_MISMATCH');
}
