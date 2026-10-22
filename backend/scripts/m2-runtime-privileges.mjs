// Owner-invoked privilege policy for separately provisioned M2 API/worker roles.
// Not a migration runner, login provisioner, startup hook or production activation.
import {createHash} from 'node:crypto';

const pins = {
 '093_integrity_envelope_jobs':'6f4d3f3e3f52fd82816aa84fc74b70c60853b27ca155670359058741f6b84b9b',
 '094_claim_cases':'e32f262ef9cba012d3bcd886476239f75876a148d3567a1e99ac76bad7f7658e',
 '095_recipient_export_preservation':'1cecb6cdc12ef5ba89e0515599c8be7b875e99a4cf1a47eee2c4be08e9a25ce2',
};
const requestColumns = ['id','proof_id','case_id','actor_user_id','idempotency_key','request_json','request_sha256','profile_id','state','created_at'];
const resultColumns = ['state','attempts','lease_token','lease_until','completed_at','failure_code','artifact_json','artifact_sha256'];
// Every listed table permits SELECT. '*' means table-level INSERT; other writes
// are column-scoped. The API cannot create accepted result or preservation rows.
const policy = {
 integrity_envelope_jobs: {api:{insert:'*'},worker:{}},
 integrity_envelope_delivery: {api:{insert:['operation_id','next_attempt_at']},worker:{update:['state','attempts','next_attempt_at','lease_token','lease_until','error_code']}},
 integrity_envelope_results: {api:{},worker:{insert:'*'}},
 claim_cases: {api:{insert:'*',update:['id']},worker:{}},
 claim_case_revisions: {api:{insert:'*'},worker:{}},
 recipient_export_jobs: {api:{insert:requestColumns},worker:{update:resultColumns}},
 recipient_export_approvals: {api:{insert:'*'},worker:{}},
 recipient_export_preservations: {api:{},worker:{insert:'*'}},
 recovery_writer_fence: {api:{update:['singleton']},worker:{update:['singleton']}},
};
const tablePrivileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
const columnPrivileges=['SELECT','INSERT','UPDATE','REFERENCES'];
const fail=code=>{throw Error(code);};
const quote=name=>{if(typeof name!=='string'||! /^[a-z][a-z0-9_]{0,62}$/.test(name))fail('M2_ROLE_IDENTIFIER_INVALID');return '"'+name+'"';};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function inspect(tx,roles){
 const names=Object.keys(policy),identities=Object.values(roles);
 if(identities.length!==2||identities[0]===identities[1])fail('M2_SEPARATE_ROLES_REQUIRED');
 identities.forEach(quote);
 const receipts=(await tx.query('SELECT id,checksum FROM schema_migrations WHERE id=ANY($1::text[]) ORDER BY id',[Object.keys(pins)])).rows;
 if(receipts.length!==3||receipts.some(row=>pins[row.id]!==row.checksum))fail('M2_MIGRATION_RECEIPTS_MISMATCH');
 const columns=(await tx.query(`SELECT c.relname AS name,a.attname AS column_name,c.relowner
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,[names])).rows;
 if(new Set(columns.map(row=>row.name)).size!==names.length)fail('M2_SCHEMA_MISSING');
 for(const role of identities){
  const unsafe=(await tx.query(`SELECT r.rolname FROM pg_roles r WHERE pg_has_role($1,r.oid,'MEMBER')
   AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.oid=ANY($2::oid[]))`,[role,[...new Set(columns.map(row=>row.relowner))]])).rows;
  if(unsafe.length||(await tx.query('SELECT has_schema_privilege($1,current_schema(),\'CREATE\') AS allowed',[role])).rows[0].allowed)fail('M2_ROLE_AUTHORITY_UNSAFE');
 }
 if((await tx.query("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS shared",identities)).rows[0].shared)fail('M2_SEPARATE_ROLES_REQUIRED');
 const tables=(await tx.query(`SELECT roles.role,c.relname AS name,p.privilege,has_table_privilege(roles.role,c.oid,p.privilege) AS allowed
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($1::text[]) roles(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY roles.role,c.relname,p.privilege`,[identities,names,tablePrivileges])).rows;
 const fields=(await tx.query(`SELECT roles.role,c.relname AS name,a.attname AS column_name,p.privilege,has_column_privilege(roles.role,c.oid,a.attnum,p.privilege) AS allowed
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest($1::text[]) roles(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY roles.role,c.relname,a.attnum,p.privilege`,[identities,names,columnPrivileges])).rows;
 return {columns,tables,fields};
}
function check(state,roles){
 const kind=Object.fromEntries(Object.entries(roles).map(([key,value])=>[value,key]));
 for(const row of state.tables){
  const rule=policy[row.name][kind[row.role]];
  const expected=row.privilege==='SELECT'||(row.privilege==='INSERT'&&rule.insert==='*');
  if(row.allowed!==expected)fail('M2_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');
 }
 for(const row of state.fields){
  const rule=policy[row.name][kind[row.role]],grant=rule[row.privilege.toLowerCase()];
  const expected=row.privilege==='SELECT'||grant==='*'||Array.isArray(grant)&&grant.includes(row.column_name);
  if(row.allowed!==expected)fail('M2_EFFECTIVE_COLUMN_PRIVILEGES_MISMATCH');
 }
}
/** Effective checks include inherited and PUBLIC grants. Revoking a direct grant
 * never overrides those; any excess authority aborts the whole transaction. */
export async function verifyM2RuntimePrivileges(db,{apiRole,workerRole}){
 const roles={api:apiRole,worker:workerRole},state=await inspect(db,roles);check(state,roles);
 return {schema:'packproof.m2-database-privileges.v1',apiRole,workerRole,policySha256:digest(policy),effectivePrivilegesSha256:digest({tables:state.tables,fields:state.fields}),migrations:pins};
}
export async function applyM2RuntimePrivileges(db,{apiRole,workerRole}){
 const roles={api:apiRole,worker:workerRole};
 return db.transaction(async tx=>{
  await tx.query("SET LOCAL lock_timeout='5s'");
  await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
  const before=await inspect(tx,roles);
  for(const [table,rules] of Object.entries(policy)){
   const columns=before.columns.filter(row=>row.name===table).map(row=>quote(row.column_name)).join(',');
   for(const [kind,role] of Object.entries(roles)){
    const target=quote(table),who=quote(role),rule=rules[kind];
    await tx.query(`REVOKE ALL PRIVILEGES ON TABLE ${target} FROM ${who}`);
    // PostgreSQL table REVOKE does not clear separately granted column rights.
    await tx.query(`REVOKE ALL PRIVILEGES (${columns}) ON TABLE ${target} FROM ${who}`);
    await tx.query(`GRANT SELECT ON TABLE ${target} TO ${who}`);
    for(const operation of ['insert','update']){
     const fields=rule[operation];
     if(fields)await tx.query(`GRANT ${operation.toUpperCase()}${fields==='*'?'':'('+fields.map(quote).join(',')+')'} ON TABLE ${target} TO ${who}`);
    }
   }
  }
  return verifyM2RuntimePrivileges(tx,{apiRole,workerRole});
 });
}
