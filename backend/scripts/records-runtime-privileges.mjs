// Reviewed, owner-operated SQL planning and read-only runtime admission.
// Never runs migrations, creates roles, changes memberships, or applies grants.
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';

const fail=code=>{throw new Error(code);};
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const quote=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(value)||value.startsWith('pg_'))fail('RECORDS_IDENTIFIER_INVALID');return `"${value}"`;};
const select={select:true};
// Baseline canonical/platform permissions are deliberately outside this policy.
// Every write is column scoped; append-only data receives no UPDATE/DELETE.
const policy={
 record_locations:{api:select,worker:select},
 record_membership_locations:{api:select,worker:select},
 record_state:{api:{...select,insert:['proof_id','organization_id','environment','revision','title','reference','location_id','updated_at'],update:['revision','lifecycle','review_state','title','reference','location_id','updated_at']},worker:{...select,insert:['proof_id','organization_id','environment','revision','title','reference','location_id','updated_at'],update:['revision','updated_at']}},
 record_entities:{api:{...select,insert:'*'},worker:{...select,insert:'*'}},
 record_evidence_links:{api:{...select,insert:'*'},worker:select},
 record_requirements:{api:{...select,insert:'*'},worker:select},
 record_requirement_waivers:{api:{...select,insert:'*'},worker:select},
 record_issues:{api:{...select,insert:'*'},worker:select},
 record_issue_actions:{api:{...select,insert:['id','issue_id','action','reason','actor_user_id','created_at']},worker:select},
 record_amendments:{api:{...select,insert:'*'},worker:select},
 record_command_results:{api:{...select,insert:['organization_id','environment','actor_id','operation','key_hash','request_hash','created_at'],update:['response']},worker:{}},
 record_import_jobs:{api:{...select,insert:['id','organization_id','environment','created_by','source_name','integration_account_id','preview_version','mapping_version','mapping','headers','delimiter','time_zone','original_object_key','original_version_id','original_sha256','original_byte_size','state','received_at','updated_at'],update:['committed_by','state','import_valid_rows','updated_at','lease_token','lease_expires_at','last_error_code']},worker:{...select,update:['state','lease_token','lease_expires_at','updated_at','last_error_code']}},
 record_import_rows:{api:{...select,insert:['import_id','row_number','status','source_values','normalized','payload_sha256','errors','proof_id'],update:['status','errors']},worker:{...select,update:['status','proof_id','attempts','errors']}},
 record_connection_state:{api:{...select,insert:['connection_id','organization_id','environment','updated_at'],update:['paused','control_revision','updated_at']},worker:{...select,update:['last_success_at','watermark_checked_at','expected_interval_seconds','last_error_code','updated_at']}},
 record_connection_operations:{api:{...select,insert:['id','connection_id','organization_id','environment','actor_user_id','action','idempotency_key_hash','request_hash','control_revision','state','next_attempt_at','created_at','updated_at']},worker:{...select,update:['state','attempts','lease_token','lease_expires_at','next_attempt_at','error_code','updated_at']}},
 record_workspace_requests:{api:{...select,insert:'*'},worker:{}},
 record_ingestion_operations:{api:{...select,insert:['id','organization_id','environment','connection_id','connection_revision','principal_id','credential_id','delegation_id','actor_context','request_id','received_at','state','next_attempt_at','updated_at'],update:['state']},worker:{...select,update:['state','lease_token','lease_expires_at','updated_at','next_attempt_at','attempts']}},
 record_source_receipts:{api:{...select,insert:['id','operation_id','item_index','organization_id','environment','connection_id','source_event_id','proof_id','reported_at','received_at','payload_canonical','payload_sha256','normalized','state','duplicate_of','error_code']},worker:{...select,update:['state','canonical_event_id','error_code','attempts']}},
 record_source_identities:{api:{...select,insert:'*'},worker:select},
 partner_import_jobs:{api:{...select,insert:'*',update:['state','import_valid_rows','updated_at']},worker:{...select,update:['state','lease_token','lease_expires_at','updated_at','last_error_code']}},
 partner_import_rows:{api:{...select,insert:'*'},worker:{...select,update:['status','errors','proof_id','attempts']}},
 record_canonical_export_jobs:{api:{...select,insert:'*'},worker:{...select,update:['state','updated_at','ready_at','object_key','object_version_id','artifact_sha256','artifact_byte_size','lease_token','lease_expires_at','attempts','last_error_code']}},
 record_source_artifacts:{api:{...select,insert:'*'},worker:select},
 record_source_upload_sessions:{api:{...select,insert:'*',update:['state','staging_version_id','received_byte_size','received_sha256','ingress_bytes','updated_at','lease_token','lease_expires_at','error_code']},worker:select},
 record_source_upload_parts:{api:{...select,insert:'*'},worker:select},
 record_source_artifact_operations:{api:{...select,insert:'*'},worker:{...select,update:['state','attempts','next_attempt_at','updated_at','lease_token','lease_expires_at','error_code']}},
 record_source_artifact_results:{api:select,worker:{...select,insert:'*'}},
 record_source_upload_budgets:{api:{...select,insert:'*',update:['reserved_bytes']},worker:select},
 operational_snapshot_candidates:{api:{...select,insert:'*'},worker:select},
 operational_snapshot_delivery:{api:{...select,insert:['snapshot_id','next_attempt_at']},worker:{...select,update:['state','attempts','next_attempt_at','lease_token','lease_until','error_code']}},
 operational_snapshot_results:{api:select,worker:{...select,insert:'*'}},
 record_snapshot_shares:{api:{...select,insert:['id','proof_id','organization_id','environment','owner_kind','owner_context','target_kind','target_id','selection_sha256','token_sha256','recipient_hint','created_by','created_at','expires_at'],update:['revoked_at','revoked_by','revoke_reason']},worker:select},
 record_deletion_contexts:{api:{...select,insert:'*'},worker:select},
 record_deletion_reviews:{api:{...select,insert:'*'},worker:select},
 record_requirement_templates:{api:{...select,insert:'*'},worker:select},
 record_requirement_assignments:{api:{...select,insert:'*'},worker:select},
 record_issue_assignments:{api:{...select,insert:'*'},worker:select},
 // Installation approval, configuration and credential lifecycle are API-only
 // decisions. The import worker can observe the current restriction, never
 // approve/rebind an installation or mint enrollment authority.
 record_agent_enrollments:{api:{...select,insert:['id','secret_hash','comparison_code','device_name','device_hash','version','created_at','expires_at'],update:['state','last_poll_at','installation_id','credential_response']},worker:{}},
 record_agent_installations:{api:{...select,insert:['id','organization_id','environment','principal_id','credential_id','integration_account_id','operator_membership_id','location_id','source_name','device_name','version','approval_user_id','enrollment_expires_at','created_at','updated_at'],update:['credential_id','status','config_revision','approved_config','config_sha256','pending_proposal','pending_proposal_sha256','test_import_id','verified_import_id','approval_user_id','enrollment_acknowledged_at','updated_at','last_seen_at','version','heartbeat','renewal_credential_id','renewal_response','renewal_expires_at','renewal_key_hash']},worker:select},
};
const tablePrivileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
const fieldPrivileges=['SELECT','INSERT','UPDATE','REFERENCES'];
const sequenceName='record_issue_actions_sequence_seq';
const sequencePrivileges=['SELECT','UPDATE','USAGE'];
const authorityFunction='lock_operational_snapshot_authority(text,text,text,text,text)';
const policyDigest=()=>sha({tables:policy,authorityFunction});

function sourceColumns(sql,existing={}){
 const tables=Object.fromEntries(Object.entries(existing).map(([table,columns])=>[table,[...columns]]));
 // These reviewed CREATE TABLE statements use ordinary quoted SQL literals.
 // Parse comma/parenthesis nesting rather than splitting CHECK/FK expressions.
 for(const match of sql.matchAll(/CREATE TABLE ([a-z][a-z0-9_]*)\s*\(/g)){
  let depth=1,quoted=false,end=match.index+match[0].length;
  const start=end;
  for(;end<sql.length;end++){
   const c=sql[end];if(c==="'"){if(quoted&&sql[end+1]==="'"){end++;continue;}quoted=!quoted;continue;}
   if(!quoted){if(c==='(')depth++;if(c===')'&&--depth===0)break;}
  }
  if(depth!==0)fail('RECORDS_SOURCE_SCHEMA_UNSUPPORTED');
  const parts=[];let part='',level=0;quoted=false;
  for(const c of sql.slice(start,end)){
   if(c==="'")quoted=!quoted;
   if(!quoted){if(c==='(')level++;if(c===')')level--;if(c===','&&level===0){parts.push(part);part='';continue;}}
   part+=c;
  }parts.push(part);
  tables[match[1]]=parts.flatMap(part=>{const column=part.trim().match(/^([a-z][a-z0-9_]*)\s+/);return column?[column[1]]:[];});
 }
 // Migration 108 appends immutable installation/revision bindings to the
 // existing import receipt. Include these additive columns in exact schema
 // admission and column-scoped INSERT planning; worker UPDATE stays explicit.
 for(const match of sql.matchAll(/ALTER TABLE ([a-z][a-z0-9_]*) ADD COLUMN ([a-z][a-z0-9_]*)\s+/g)){
  // Canonical/platform tables predate this narrowly scoped records policy.
  if(!tables[match[1]])continue;
  if(tables[match[1]].includes(match[2]))fail('RECORDS_SOURCE_SCHEMA_UNSUPPORTED');
  tables[match[1]].push(match[2]);
 }
 return tables;
}

export async function recordsMigrationInventory(){
 const directory=new URL('../migrations/',import.meta.url);
 const files=(await readdir(directory)).filter(name=>/^(09[6-9]|10[0-8])_[a-z0-9_]+\.sql$/.test(name)).sort();
 if(files.length!==13||new Set(files.map(f=>f.slice(0,3))).size!==13)fail('RECORDS_SOURCE_MIGRATIONS_INCOMPLETE');
 const migrations={};let tableColumns={};for(const file of files){const sql=await readFile(new URL(file,directory),'utf8');migrations[file.slice(0,-4)]=sha(sql);tableColumns=sourceColumns(sql,tableColumns);}
 if(Object.keys(policy).some(table=>!tableColumns[table]?.length)||Object.keys(tableColumns).some(table=>!policy[table]))fail('RECORDS_SOURCE_POLICY_INCOMPLETE');
 return {migrations,migrationSha256:sha(migrations),tableColumns};
}
async function options(input){
 if(!input||Object.keys(input).some(k=>!['runtimeRole','workerRole','schema','reviewedSourceCommit','reviewedMigrationSha256'].includes(k)))fail('RECORDS_REVIEW_OPTIONS_INVALID');
 const {runtimeRole,workerRole,schema,reviewedSourceCommit,reviewedMigrationSha256}=input;
 [runtimeRole,workerRole,schema].forEach(quote);
 if(runtimeRole===workerRole)fail('RECORDS_SEPARATE_ROLES_REQUIRED');
 if(!/^[a-f0-9]{40}$/.test(reviewedSourceCommit??''))fail('RECORDS_REVIEWED_SOURCE_REQUIRED');
 const source=await recordsMigrationInventory();
 if(!/^[a-f0-9]{64}$/.test(reviewedMigrationSha256??'')||reviewedMigrationSha256!==source.migrationSha256)fail('RECORDS_SOURCE_REVIEW_MISMATCH');
 return {...input,...source,roles:{api:runtimeRole,worker:workerRole}};
}
async function inspect(db,o,actualCaller){
 const identity=(await db.query('SELECT current_user AS caller,session_user AS session_caller,current_schema() AS schema')).rows[0];
 if(!identity||identity.schema!==o.schema)fail('RECORDS_SCHEMA_CONTEXT_MISMATCH');
 if(actualCaller&&(!Object.values(o.roles).includes(identity.caller)||identity.session_caller!==identity.caller))fail('RECORDS_RUNTIME_CALLER_REQUIRED');
 const receipts=(await db.query(`SELECT id,checksum FROM ${quote(o.schema)}.schema_migrations WHERE id=ANY($1::text[]) ORDER BY id`,[Object.keys(o.migrations)])).rows;
 if(receipts.length!==Object.keys(o.migrations).length||receipts.some(row=>o.migrations[row.id]!==row.checksum))fail('RECORDS_MIGRATION_RECEIPTS_MISMATCH');
 const names=Object.keys(policy),roles=Object.values(o.roles);
 const columns=(await db.query(`SELECT c.relname AS name,a.attname AS column_name,c.relowner FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname,a.attnum`,[o.schema,names])).rows;
 if(new Set(columns.map(row=>row.name)).size!==names.length)fail('RECORDS_SCHEMA_MISSING');
 for(const table of names)if(JSON.stringify(columns.filter(c=>c.name===table).map(c=>c.column_name))!==JSON.stringify(o.tableColumns[table]))fail('RECORDS_SCHEMA_COLUMNS_MISMATCH');
 for(const [table,rules] of Object.entries(policy))for(const rule of Object.values(rules))for(const operation of ['insert','update']){
  if(Array.isArray(rule[operation])&&rule[operation].some(field=>!columns.some(c=>c.name===table&&c.column_name===field)))fail('RECORDS_POLICY_COLUMN_MISSING');
 }
 const exists=(await db.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows;
 if(exists.length!==2)fail('RECORDS_ROLES_NOT_PROVISIONED');
 for(const role of roles){
  const unsafe=(await db.query(`SELECT r.rolname FROM pg_roles r WHERE pg_has_role($1,r.oid,'MEMBER') AND
   (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR
    r.oid IN(SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2) OR
    r.oid IN(SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2) OR
    r.oid=(SELECT nspowner FROM pg_namespace WHERE nspname=$2) OR r.oid=(SELECT datdba FROM pg_database WHERE datname=current_database()))`,[role,o.schema])).rows;
  const schema=(await db.query("SELECT has_schema_privilege($1,$2,'USAGE') AS usage,has_schema_privilege($1,$2,'CREATE') AS create,has_schema_privilege($1,$2,'USAGE WITH GRANT OPTION') AS grantable",[role,o.schema])).rows[0];
  if(unsafe.length||!schema?.usage||schema.create||schema.grantable)fail('RECORDS_ROLE_AUTHORITY_UNSAFE');
 }
 if((await db.query("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS shared",roles)).rows[0].shared)fail('RECORDS_SEPARATE_ROLES_REQUIRED');
 const tables=(await db.query(`SELECT roles.role,c.relname AS name,p.privilege,has_table_privilege(roles.role,c.oid,p.privilege) AS allowed,
 has_table_privilege(roles.role,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($1::text[]) roles(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=$4 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY roles.role,c.relname,p.privilege`,[roles,names,tablePrivileges,o.schema])).rows;
 const fields=(await db.query(`SELECT roles.role,c.relname AS name,a.attname AS column_name,p.privilege,
 has_column_privilege(roles.role,c.oid,a.attnum,p.privilege) AS allowed,has_column_privilege(roles.role,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest($1::text[]) roles(role) CROSS JOIN unnest($3::text[]) p(privilege)
 WHERE n.nspname=$4 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY roles.role,c.relname,a.attnum,p.privilege`,[roles,names,fieldPrivileges,o.schema])).rows;
 const sequences=(await db.query(`SELECT roles.role,c.relname AS name,p.privilege,has_sequence_privilege(roles.role,c.oid,p.privilege) AS allowed,
 has_sequence_privilege(roles.role,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN unnest($1::text[]) roles(role) CROSS JOIN unnest($2::text[]) p(privilege) WHERE n.nspname=$3 AND c.relkind='S' AND c.relname=$4 ORDER BY roles.role,p.privilege`,[roles,sequencePrivileges,o.schema,sequenceName])).rows;
 if(sequences.length!==6)fail('RECORDS_SEQUENCE_MISSING');
 const publicFunction=(await db.query(`SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure($1) AND a.grantee=0 AND a.privilege_type='EXECUTE' LIMIT 1`,[`${quote(o.schema)}.${authorityFunction}`])).rows;
 if(publicFunction.length)fail('RECORDS_FUNCTION_PUBLIC_ACCESS_UNSAFE');
 const functions=(await db.query(`SELECT role,has_function_privilege(role,$2,'EXECUTE') AS allowed,has_function_privilege(role,$2,'EXECUTE WITH GRANT OPTION') AS grantable
 FROM unnest($1::text[]) roles(role) ORDER BY role`,[roles,`${quote(o.schema)}.${authorityFunction}`])).rows;
 return {identity,columns,tables,fields,sequences,functions};
}
function verify(state,o){
 if([...state.tables,...state.fields,...state.sequences,...state.functions].some(row=>row.grantable))fail('RECORDS_DELEGABLE_PRIVILEGES_UNSAFE');
 const kind=Object.fromEntries(Object.entries(o.roles).map(([k,v])=>[v,k]));
 for(const row of state.tables){const rule=policy[row.name][kind[row.role]],expected=row.privilege==='SELECT'&&!!rule.select;if(row.allowed!==expected)fail('RECORDS_EFFECTIVE_TABLE_PRIVILEGES_MISMATCH');}
 for(const row of state.fields){const rule=policy[row.name][kind[row.role]],grant=rule[row.privilege.toLowerCase()],expected=row.privilege==='SELECT'?!!rule.select:grant==='*'||Array.isArray(grant)&&grant.includes(row.column_name);if(row.allowed!==expected)fail('RECORDS_EFFECTIVE_COLUMN_PRIVILEGES_MISMATCH');}
 for(const row of state.sequences)if(row.allowed!==(row.role===o.runtimeRole&&row.privilege==='USAGE'))fail('RECORDS_EFFECTIVE_SEQUENCE_PRIVILEGES_MISMATCH');
 if(state.functions.length!==2||state.functions.some(row=>!row.allowed))fail('RECORDS_AUTHORITY_LOCK_PRIVILEGES_MISMATCH');
}
/** Read-only, actual-caller preflight. Effective PUBLIC/inherited privileges count. */
export async function verifyRecordsRuntimePrivileges(db,input){
 const o=await options(input);
 if(process.env.PACKPROOF_RELEASE_SHA!==o.reviewedSourceCommit)fail('RECORDS_RUNTIME_SOURCE_MISMATCH');
 const state=await inspect(db,o,true);verify(state,o);
 return {schema:'packproof.records-runtime-privileges/v1',sourceCommit:o.reviewedSourceCommit,databaseSchema:o.schema,caller:state.identity.caller,
  runtimeRole:o.runtimeRole,workerRole:o.workerRole,migrations:o.migrations,migrationSha256:o.migrationSha256,policySha256:policyDigest(),effectivePrivilegesSha256:sha({tables:state.tables,fields:state.fields,sequences:state.sequences,functions:state.functions})};
}
/** Owner-operated planning only. Caller must execute the reviewed statements in
 * one transaction, rerun actual-role preflight, and separately verify baseline
 * domain permissions. Excess inherited/PUBLIC grants must be fixed by their owner. */
export async function planRecordsRuntimePrivileges(db,input){
 const o=await options(input),state=await inspect(db,o,false),statements=[];
 for(const [table,rules] of Object.entries(policy))for(const [kind,role] of Object.entries(o.roles)){
  const target=`${quote(o.schema)}.${quote(table)}`,who=quote(role),columns=state.columns.filter(c=>c.name===table).map(c=>quote(c.column_name)).join(','),rule=rules[kind];
  statements.push(`REVOKE ALL PRIVILEGES ON TABLE ${target} FROM ${who}`,`REVOKE ALL PRIVILEGES (${columns}) ON TABLE ${target} FROM ${who}`);
  if(rule.select)statements.push(`GRANT SELECT ON TABLE ${target} TO ${who}`);
  for(const op of ['insert','update'])if(rule[op])statements.push(`GRANT ${op.toUpperCase()}(${rule[op]==='*'?columns:rule[op].map(quote).join(',')}) ON TABLE ${target} TO ${who}`);
 }
 const sequence=`${quote(o.schema)}.${quote(sequenceName)}`;
 for(const role of Object.values(o.roles))statements.push(`REVOKE ALL PRIVILEGES ON SEQUENCE ${sequence} FROM ${quote(role)}`);
 statements.push(`GRANT USAGE ON SEQUENCE ${sequence} TO ${quote(o.runtimeRole)}`);
 for(const role of Object.values(o.roles))statements.push(`REVOKE ALL PRIVILEGES ON FUNCTION ${quote(o.schema)}.${authorityFunction} FROM ${quote(role)}`,
  `GRANT EXECUTE ON FUNCTION ${quote(o.schema)}.${authorityFunction} TO ${quote(role)}`);
 return {schema:'packproof.records-privilege-plan/v1',sourceCommit:o.reviewedSourceCommit,databaseSchema:o.schema,runtimeRole:o.runtimeRole,workerRole:o.workerRole,
  migrations:o.migrations,migrationSha256:o.migrationSha256,policySha256:policyDigest(),statementsSha256:sha(statements),statements};
}
