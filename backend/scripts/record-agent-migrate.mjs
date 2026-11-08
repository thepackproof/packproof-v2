// One additive 107 -> 108 operator for an explicitly reviewed, isolated G1
// staging database. Historical 095 -> 107 release operators remain frozen.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {inspectAgentMigrationInventory} from './record-agent-migration-inventory.mjs';
import {recordsMigrationInventory,planRecordsRuntimePrivileges} from './records-runtime-privileges.mjs';
import {verifyRecordAgentSchemaCatalog} from './record-agent-schema.mjs';

export const agentManifest=JSON.parse(readFileSync(new URL('./record-agent-migration-manifest.json',import.meta.url),'utf8'));
export const agentDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
export const quoteAgentIdentifier=name=>{if(typeof name!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(name))fail('AGENT_IDENTIFIER_INVALID');return '"'+name+'"';};
const newTables=['record_agent_enrollments','record_agent_installations'];
const newColumns=['agent_installation_id','agent_config_revision'];
const newConstraints=['partner_import_jobs_agent_installation_id_fkey','partner_import_jobs_agent_config_revision_check','partner_import_agent_revision'];
const productionHost='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const image=value=>/^sha256:[a-f0-9]{64}$/.test(value??'');
const host=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9.-]+\.rds\.amazonaws\.com$/.test(value)&&value!==productionHost;

export function validateAgentReview(review){
 if(!/^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[a-zA-Z0-9_-]+$/.test(review?.clusterArn??''))fail('AGENT_REVIEWED_CLUSTER_REQUIRED');
 if(review?.schema!=='packproof.record-agent-staging-review/v1'||review.environment!=='staging'||review.approvedNonproduction!==true||!host(review.target?.host)||!host(review.restored?.host)||review.target.host===review.restored.host)fail('AGENT_APPROVED_ISOLATED_TARGET_REQUIRED');
 if(!/^[a-f0-9]{40}$/.test(review.source??'')||!/^[a-f0-9]{40}$/.test(review.previousSource??'')||review.source===review.previousSource||!image(review.candidateImage)||!image(review.previousImage)||review.candidateImage===review.previousImage||review.inventorySha256!==agentManifest.inventorySha256||review.predecessorInventorySha256!==agentManifest.predecessorInventorySha256)fail('AGENT_RELEASE_SOURCE_IMAGE_BINDING_REQUIRED');
 for(const value of [review.target.database,review.restored.database,review.ownerRole,review.apiRole,review.workerRole])quoteAgentIdentifier(value);
 if(new Set([review.ownerRole,review.apiRole,review.workerRole]).size!==3)fail('AGENT_SEPARATE_EXISTING_ROLES_REQUIRED');
 return agentDigest(review);
}
/** Bind one-shot evidence to the actual immutable ECS image and reviewed cluster. */
export function validateAgentTaskMetadata(container,task,review,expectedImage){
 validateAgentReview(review);
 const prefix=review.clusterArn.replace(':cluster/',':task/')+'/';
 if(container?.ImageID!==expectedImage||!task?.TaskARN?.startsWith(prefix)||!/^[a-f0-9]{32}$/.test(task.TaskARN.slice(prefix.length)))fail('AGENT_ACTUAL_TASK_IMAGE_CLUSTER_MISMATCH');
 return {taskArn:task.TaskARN,image:container.ImageID};
}
export async function agentTaskIdentity(env,review,expectedImage){
 let endpoint;try{endpoint=new URL(env.ECS_CONTAINER_METADATA_URI_V4);}catch{fail('AGENT_ECS_TASK_METADATA_REQUIRED');}
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='169.254.170.2'||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/v4\/[a-zA-Z0-9_-]+$/.test(endpoint.pathname))fail('AGENT_ECS_TASK_METADATA_REQUIRED');
 const get=async suffix=>{const response=await fetch(endpoint.href+suffix,{signal:AbortSignal.timeout(5000)});if(!response.ok)fail('AGENT_ECS_TASK_METADATA_UNAVAILABLE');return response.json();};
 const [container,task]=await Promise.all([get(''),get('/task')]);return validateAgentTaskMetadata(container,task,review,expectedImage);
}
function fresh(at,now,maximum,code){const age=now.getTime()-Date.parse(at);if(!Number.isFinite(age)||age<0||age>maximum)fail(code);}
export function agentInspection(state,review,now=new Date()){
 const reviewSha256=validateAgentReview(review),body={schema:'packproof.record-agent-migration-inspection/v1',reviewSha256,createdAt:now.toISOString(),state};
 return {...body,sha256:agentDigest(body)};
}
export function validateAgentInspection(receipt,state,review,now=new Date()){
 const {sha256,...body}=receipt??{};
 if(sha256!==agentDigest(body)||body.schema!=='packproof.record-agent-migration-inspection/v1'||body.reviewSha256!==validateAgentReview(review))fail('AGENT_INSPECTION_BINDING_MISMATCH');
 fresh(body.createdAt,now,900000,'AGENT_INSPECTION_EXPIRED');
 if(agentDigest(body.state)!==agentDigest(state))fail('AGENT_INSPECTION_STATE_CHANGED');
}
export function validateAgentRehearsal(receipt,review,now=new Date()){
 const {sha256,...body}=receipt??{},reviewSha256=validateAgentReview(review);
 if(sha256!==agentDigest(body)||body.schema!=='packproof.record-agent-release-rehearsal/v1'||body.reviewSha256!==reviewSha256||body.source!==review.source||body.previousSource!==review.previousSource||body.candidateImage!==review.candidateImage||body.previousImage!==review.previousImage||body.restoredHost!==review.restored.host||body.restoredDatabase!==review.restored.database||body.inventorySha256!==agentManifest.inventorySha256)fail('AGENT_REHEARSAL_BINDING_MISMATCH');
 const cluster=review.clusterArn?.match(/^arn:aws:ecs:([a-z0-9-]+):([0-9]{12}):cluster\/([a-zA-Z0-9_-]+)$/);
 if(!cluster)fail('AGENT_REVIEWED_REHEARSAL_CLUSTER_REQUIRED');
 const taskPrefix=`arn:aws:ecs:${cluster[1]}:${cluster[2]}:task/${cluster[3]}/`;
 const task=value=>typeof value==='string'&&value.startsWith(taskPrefix)&&/^[a-f0-9]{32}$/.test(value.slice(taskPrefix.length));
 if(body.migrationExitCode!==0||body.previousImageExitCode!==0||body.baselinePreserved!==true||body.runtimeAuthorityPreserved!==true||!Array.isArray(body.taskArns)||body.taskArns.length!==2||new Set(body.taskArns).size!==2||body.taskArns.some(arn=>!task(arn))||!task(body.migrationTaskArn)||!body.taskArns.includes(body.migrationTaskArn))fail('AGENT_REHEARSAL_NOT_QUALIFIED');
 const sealed=(report,expectedHash)=>{
  const {sha256:reportSha256,...reportBody}=report??{};
  if(!/^[a-f0-9]{64}$/.test(expectedHash??'')||reportSha256!==expectedHash||reportSha256!==agentDigest(reportBody))fail('AGENT_REHEARSAL_REPORT_REQUIRED');
  fresh(reportBody.completedAt,now,86400000,'AGENT_REHEARSAL_REPORT_EXPIRED');
  if(Date.parse(reportBody.completedAt)>Date.parse(body.completedAt))fail('AGENT_REHEARSAL_REPORT_ORDER_INVALID');
  return reportBody;
 };
 const migration=sealed(body.migrationReport,body.migrationReportSha256);
 if(migration.schema!=='packproof.record-agent-migration-application/v1'||migration.reviewSha256!==reviewSha256||migration.source!==review.source||migration.candidateImage!==review.candidateImage||migration.previousSource!==review.previousSource||migration.previousImage!==review.previousImage||migration.taskArn!==body.migrationTaskArn||migration.image!==review.candidateImage||migration.targetHost!==review.restored.host||migration.targetDatabase!==review.restored.database||migration.inventorySha256!==review.inventorySha256||migration.appliedCount!==agentManifest.sourceCount||migration.alreadyApplied!==false||migration.rehearsal!==true||migration.baselinePreserved!==true||migration.runtimeAuthorityPreserved!==true||migration.rolesChanged!==false||migration.featureActivation!==false||!['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'].every(key=>/^[a-f0-9]{64}$/.test(migration[key]??'')))fail('AGENT_REHEARSAL_MIGRATION_REPORT_MISMATCH');
 const probe=sealed(body.previousImageReport,body.previousImageReportSha256);
 if(probe.schema!=='packproof.record-agent-previous-image-probe/v1'||probe.reviewSha256!==reviewSha256||probe.source!==review.previousSource||probe.image!==review.previousImage||probe.targetHost!==review.restored.host||probe.targetDatabase!==review.restored.database||probe.clusterArn!==review.clusterArn||!task(probe.taskArn)||!body.taskArns.includes(probe.taskArn)||probe.taskArn===body.migrationTaskArn||probe.inventorySha256!==review.inventorySha256||probe.migrationCount!==agentManifest.sourceCount||probe.processRole!=='api'||probe.databaseReadOnly!==true||probe.workersStarted!==false||probe.featuresActivated!==false||probe.schemaCurrent!==true||probe.identity?.role!==review.apiRole||probe.identity?.login!==review.apiRole||probe.identity?.database!==review.restored.database||probe.identity?.schema!=='public'||probe.identity?.default_read_only!=='on'||probe.tls?.ssl!==true||probe.metaCommit!==review.previousSource||probe.metaImage!==review.previousImage)fail('AGENT_REHEARSAL_PREVIOUS_IMAGE_REPORT_MISMATCH');
 if(!Array.isArray(probe.checks)||probe.checks.length!==3||['/meta','/health','/ready'].some(route=>probe.checks.filter(check=>check.route===route&&check.status===200).length!==1))fail('AGENT_REHEARSAL_PREVIOUS_IMAGE_READINESS_REQUIRED');
 if(Date.parse(probe.completedAt)<Date.parse(migration.completedAt))fail('AGENT_REHEARSAL_REPORT_ORDER_INVALID');
 fresh(body.completedAt,now,86400000,'AGENT_REHEARSAL_EXPIRED');return sha256;
}

async function baseline(db,review){
 const columns=(await db.query(`SELECT c.relname AS name,a.attname AS column_name,c.relowner,c.relacl::text AS acl,a.attacl::text AS column_acl,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,pg_get_expr(d.adbin,d.adrelid) AS default_value
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind='r' AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,[newTables])).rows.filter(row=>row.name!=='partner_import_jobs'||!newColumns.includes(row.column_name));
 const tables=[...new Set(columns.map(row=>row.name))],data={};
 for(const table of tables){
  if(table==='schema_migrations')continue;
  const fields=columns.filter(row=>row.name===table).map(row=>quoteAgentIdentifier(row.column_name)).join(',');
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${fields} FROM ${quoteAgentIdentifier(table)}) t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
  if(rows.length>100000)fail('AGENT_INSPECTION_BOUND_EXCEEDED');data[table]={count:rows.length,sha256:agentDigest(rows)};
 }
 const constraints=(await db.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`,[newTables])).rows.filter(row=>row.relname!=='partner_import_jobs'||!newConstraints.includes(row.conname));
 const indexes=(await db.query(`SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT c.relname=ANY($1::text[]) ORDER BY c.relname,i.indexrelid`,[newTables])).rows;
 const triggers=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,[newTables])).rows.filter(row=>row.relname!=='partner_import_jobs'||row.tgname!=='partner_import_agent_revision_immutable');
 const functions=(await db.query(`SELECT oid,proname,prosrc,prosecdef,proconfig,provolatile,proparallel,prorettype,proargtypes::text AS arguments,proacl::text AS acl FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname<>'preserve_partner_import_agent_revision' ORDER BY oid`)).rows;
 const defaults=(await db.query('SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text AS acl FROM pg_default_acl WHERE defaclnamespace=current_schema()::regnamespace ORDER BY defaclrole,defaclobjtype')).rows;
 const sequences=(await db.query("SELECT relname,relowner,relacl::text AS acl FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='S' ORDER BY relname")).rows;
 const authority=[];
 for(const role of [review.apiRole,review.workerRole]){
  const roles=(await db.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,rolinherit,rolconnlimit,rolvaliduntil FROM pg_roles WHERE pg_has_role($1,oid,'MEMBER') ORDER BY rolname",[role])).rows;
  const schema=(await db.query("SELECT has_schema_privilege($1,current_schema(),'USAGE') AS usage,has_schema_privilege($1,current_schema(),'CREATE') AS create",[role])).rows[0];
  const owners=(await db.query(`SELECT 1 FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND pg_has_role($1,c.relowner,'MEMBER') UNION ALL SELECT 1 FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND pg_has_role($1,p.proowner,'MEMBER') UNION ALL SELECT 1 FROM pg_namespace n WHERE n.oid=current_schema()::regnamespace AND pg_has_role($1,n.nspowner,'MEMBER') UNION ALL SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role($1,d.datdba,'MEMBER') LIMIT 1`,[role])).rows;
  if(!roles.some(row=>row.rolname===role)||roles.some(row=>row.rolsuper||row.rolcreatedb||row.rolcreaterole||row.rolreplication||row.rolbypassrls)||!schema?.usage||schema.create||owners.length)fail('AGENT_EXISTING_RUNTIME_AUTHORITY_UNSAFE');
  authority.push({role,roles,schema});
 }
 if((await db.query("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS shared",[review.apiRole,review.workerRole])).rows[0].shared)fail('AGENT_SEPARATE_EXISTING_ROLES_REQUIRED');
 return {tables,baselineDataSha256:agentDigest(data),baselineCatalogSha256:agentDigest({columns,constraints,indexes,triggers,functions,defaults,sequences}),baselineAuthoritySha256:agentDigest(authority)};
}

async function verifyAgentSchema(db,inventory){
 await verifyRecordAgentSchemaCatalog(db);
 const source=await recordsMigrationInventory(108);
 const columns=(await db.query(`SELECT c.relname AS name,a.attname AS column_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,[[...newTables,'partner_import_jobs']])).rows;
 for(const table of [...newTables,'partner_import_jobs'])if(agentDigest(columns.filter(row=>row.name===table).map(row=>row.column_name))!==agentDigest(source.tableColumns[table]))fail('AGENT_SCHEMA_COLUMNS_MISMATCH');
 const sql=inventory.find(row=>row.id==='108_record_agents').sql,body=sql.match(/CREATE FUNCTION preserve_partner_import_agent_revision\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
 const fn=(await db.query("SELECT prosrc,prosecdef FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='preserve_partner_import_agent_revision'")).rows;
 const trigger=(await db.query("SELECT t.tgtype,t.tgenabled,t.tgnargs,t.tgqual::text AS condition,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname='partner_import_jobs' AND t.tgname='partner_import_agent_revision_immutable'")).rows;
 if(fn.length!==1||fn[0].prosrc!==body||fn[0].prosecdef||trigger.length!==1||Number(trigger[0].tgtype)!==19||trigger[0].tgenabled!=='O'||Number(trigger[0].tgnargs)!==0||trigger[0].condition!==null||trigger[0].proname!=='preserve_partner_import_agent_revision')fail('AGENT_IMMUTABILITY_GUARD_MISMATCH');
 const constraints=(await db.query("SELECT conname,convalidated FROM pg_constraint WHERE conrelid='partner_import_jobs'::regclass AND conname=ANY($1::text[]) ORDER BY conname",[newConstraints])).rows;
 if(constraints.length!==3||constraints.some(row=>!row.convalidated))fail('AGENT_RECEIPT_CONSTRAINT_MISMATCH');
 for(const table of newTables)if((await db.query(`SELECT 1 FROM ${quoteAgentIdentifier(table)} LIMIT 1`)).rows.length)fail('AGENT_ACTIVITY_PRESENT');
 if((await db.query('SELECT 1 FROM partner_import_jobs WHERE agent_installation_id IS NOT NULL OR agent_config_revision IS NOT NULL LIMIT 1')).rows.length)fail('AGENT_ACTIVITY_PRESENT');
}
export async function inspectAgentState(db,inventory,review){
 validateAgentReview(review);
 const state=inspectAgentMigrationInventory(inventory,(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows,{reviewedSourceCommit:review.source,reviewedInventorySha256:review.inventorySha256});
 const names=(await db.query("SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[newTables])).rows.map(row=>row.name);
 if(state.pending){
  if(names.length||(await db.query("SELECT 1 FROM pg_attribute WHERE attrelid='partner_import_jobs'::regclass AND attname=ANY($1::text[]) AND NOT attisdropped LIMIT 1",[newColumns])).rows.length)fail('AGENT_PARTIAL_SCHEMA_PRESENT');
 }else await verifyAgentSchema(db,inventory);
 return {pending:state.pending,appliedCount:state.appliedCount,inventorySha256:state.inventorySha256,...await baseline(db,review)};
}
export async function applyAgentInTransaction(tx,inventory,receipt,review,{splitSqlStatements,now=new Date()}={}){
 validateAgentReview(review);if(typeof splitSqlStatements!=='function')fail('AGENT_SQL_SPLITTER_REQUIRED');
 await tx.query("SET LOCAL lock_timeout='15s'");await tx.query("SET LOCAL statement_timeout='30s'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
 const names=(await tx.query("SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r' ORDER BY relname")).rows.map(row=>quoteAgentIdentifier(row.name));
 // Quiesce every table included in the preservation receipt until commit.
 await tx.query(`LOCK TABLE ${names.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
 const before=await inspectAgentState(tx,inventory,review);validateAgentInspection(receipt,before,review,now);
 if(!before.pending)return {...before,alreadyApplied:true};
 const item=inventory.find(row=>row.id==='108_record_agents');
 for(const sql of splitSqlStatements(item.sql))await tx.query(sql);
 await tx.query("INSERT INTO schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[item.id,now.toISOString(),item.checksum]);
 // Do not inherit broad default grants onto the two new authority tables.
 const grants=(await tx.query(`SELECT DISTINCT c.relname,a.grantee,r.rolname FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=ANY($1::text[]) AND a.grantee<>c.relowner ORDER BY c.relname,a.grantee`,[newTables])).rows;
 for(const grant of grants)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE ${quoteAgentIdentifier(grant.relname)} FROM ${Number(grant.grantee)===0?'PUBLIC':quoteAgentIdentifier(grant.rolname)}`);
 const after=await inspectAgentState(tx,inventory,review);
 for(const key of ['baselineDataSha256','baselineCatalogSha256','baselineAuthoritySha256'])if(after[key]!==before[key])fail('AGENT_BASELINE_PRESERVATION_MISMATCH');
 return {...after,alreadyApplied:false};
}

/** Plan only108 grants for already provisioned, separately qualified roles.
 * Never create roles, rewrite historical grants, or turn on feature flags. */
export async function planAgentRuntimePrivilegeDelta(db,review){
 const reviewSha256=validateAgentReview(review),source=await recordsMigrationInventory(108);
 const plan=await planRecordsRuntimePrivileges(db,{runtimeRole:review.apiRole,workerRole:review.workerRole,schema:'public',reviewedSourceCommit:review.source,reviewedMigrationSha256:source.migrationSha256,throughMigration:108});
 const statements=plan.statements.filter(sql=>newTables.some(table=>sql.includes(` ON TABLE "public"."${table}" `)));
 statements.push(`GRANT INSERT(${newColumns.map(quoteAgentIdentifier).join(',')}) ON TABLE "public"."partner_import_jobs" TO ${quoteAgentIdentifier(review.apiRole)}`);
 return {schema:'packproof.record-agent-runtime-delta/v1',reviewSha256,source:review.source,inventorySha256:review.inventorySha256,policySha256:plan.policySha256,statementsSha256:agentDigest(statements),statements};
}
