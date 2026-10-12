// Scoped additive 079–087 operator. Runtime credentials cannot execute this path.
// Inspection is read-only; apply uses an expiring separate owner login and one transaction.
import { createHash,createHmac,pbkdf2Sync,randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const BASELINE_COUNT=77;
export const PRODUCTION_RUNTIME_ROLE='packproof_app_runtime_v1';
export const BASELINE_DIGEST='9bba1dbb8ec9f8da3f06e4d027c02a486ce692cdb3c2db7064dcd2ab2b96e4b7';
export const MIGRATIONS=Object.freeze([
 ['079_rnd_evidence','197b8149953a8e04a2216433ab262159ae736e62e7ef6de9f964de4f8547deac'],
 ['080_rnd_learning','59fb22113251274542db12f73c9a047154ea51d07bc1fa236c44585a2841dfc5'],
 ['081_rnd_platform','4d2389b653275c2e669bfaee12b38dff8204578f7be1babbc3d4e70d970b4d98'],
 ['082_rnd_enrollments','0cf27d56b58308f5614cac9d2978997004bfc1c3fbfcdedb285cbf5213239b95'],
 ['083_rnd_zk','854559fa821e2ce91eadf5019fe5656decd69c33e76358f3c789a2c34903f046'],
 ['084_rnd_annotations','4c9d508767baf69d153b007a0f4371deb61f41ca916204c0754a75d13cc2f83c'],
 ['085_rnd_capture_sidecars','194d96a7e658c4d405b9f2e5af92c65b7617e814bc6342418c694f29a235908e'],
 ['086_rnd_derivative_grants','b1ab16a8d2ebf69ee0a692e5a2943aa92722c3272813a122e3e69890d68530a7'],
 ['087_rnd_source_storage_dedup','78e9a7383e377f0df24590e78ddeaacf8f73043377a9dad8e897b00c08e879ad'],
].map(([id,checksum])=>Object.freeze({id,checksum})));
export const RECEIPT_TABLES=Object.freeze(['rnd_subjects','rnd_consents','rnd_intents','rnd_session_starts','rnd_session_receipts','rnd_sources','rnd_idempotency'].sort());
const PRIVILEGES=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
const fail=code=>{throw new Error(code);};
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest=value=>createHash('sha256').update(value).digest('hex');
const entries=rows=>rows.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
const quote=name=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(name))fail('INVALID_DATABASE_IDENTIFIER');return '"'+name+'"';};

export function inspectInventory(inventory,applied) {
 if(inventory.length!==86||new Set(inventory.map(row=>row.id)).size!==86)fail('CANDIDATE_INVENTORY_MISMATCH');
 if(inventory.some(row=>typeof row.sql!=='string'||bytesDigest(row.sql)!==row.checksum))fail('MIGRATION_BYTES_MISMATCH');
 for(const pin of MIGRATIONS)if(!inventory.some(row=>row.id===pin.id&&row.checksum===pin.checksum))fail('MIGRATION_BYTES_MISMATCH');
 const ids=new Set(MIGRATIONS.map(row=>row.id)),baseline=entries(inventory.filter(row=>!ids.has(row.id)));
 if(baseline.length!==BASELINE_COUNT||digest(baseline)!==BASELINE_DIGEST)fail('BASELINE_INVENTORY_MISMATCH');
 if(![77,86].includes(applied.length)||new Set(applied.map(row=>row.id)).size!==applied.length)fail('APPLIED_INVENTORY_MISMATCH');
 const expected=new Map(inventory.map(row=>[row.id,row.checksum]));
 if(applied.some(row=>expected.get(row.id)!==row.checksum))fail('APPLIED_CHECKSUM_MISMATCH');
 if(digest(entries(applied.filter(row=>!ids.has(row.id))))!==BASELINE_DIGEST)fail('BASELINE_RECEIPT_MISSING');
 return {pending:applied.length===77,inventoryDigest:digest(entries(inventory)),appliedDigest:digest(entries(applied)),appliedCount:applied.length};
}
export function expectedObjects(inventory) {
 const sql=MIGRATIONS.map(pin=>inventory.find(row=>row.id===pin.id)?.sql??'').join('\n');
 return {tables:[...sql.matchAll(/^CREATE TABLE (rnd_[a-z_]+)\s*\(/gm)].map(m=>m[1]).sort(),functions:[...sql.matchAll(/^CREATE FUNCTION (rnd_[a-z_]+)\s*\(/gm)].map(m=>m[1]).sort()};
}
export async function inspectState(db,inventory,runtime=PRODUCTION_RUNTIME_ROLE) {
 quote(runtime);
 const applied=(await db.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows,state=inspectInventory(inventory,applied),expected=expectedObjects(inventory);
 const tables=(await db.query("SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'rnd\\_%' ESCAPE '\\' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname")).rows;
 const functions=(await db.query("SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'rnd\\_%' ESCAPE '\\' ORDER BY p.proname")).rows;
 if(state.pending&&(tables.length||functions.length))fail('UNRECEIPTED_RND_SCHEMA');
 if(!state.pending&&(digest(tables)!==digest(expected.tables.map(name=>({name,kind:'r'})))||digest(functions)!==digest(expected.functions.map(name=>({name,args:''})))))fail('RECEIPTED_RND_SCHEMA_MISMATCH');
 const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname=$1',[runtime])).rows[0];
 if(!role||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls)fail('RUNTIME_AUTHORITY_UNSAFE');
 const core=(await db.query(`SELECT c.relname AS name,p.privilege,has_table_privilege($1,c.oid,p.privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($2::text[]) p(privilege) WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname NOT LIKE 'rnd\\_%' ESCAPE '\\' ORDER BY c.relname,p.privilege`,[runtime,PRIVILEGES])).rows;
 const memberships=(await db.query('SELECT r.rolname FROM pg_roles r WHERE pg_has_role($1,r.oid,\'MEMBER\') ORDER BY r.rolname',[runtime])).rows;
 const schema=(await db.query("SELECT has_schema_privilege($1,'public','USAGE') AS usage,has_schema_privilege($1,'public','CREATE') AS create",[runtime])).rows[0];
 if(schema.create)fail('RUNTIME_SCHEMA_AUTHORITY_UNSAFE');
 const rndPrivileges=state.pending?[]:(await db.query(`SELECT c.relname AS name,p.privilege,has_table_privilege($1,c.oid,p.privilege) AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($2::text[]) p(privilege) WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'rnd\\_%' ESCAPE '\\' ORDER BY c.relname,p.privilege`,[runtime,PRIVILEGES])).rows;
 return {...state,tables:tables.map(row=>row.name),functions:functions.map(row=>row.name),runtimeAuthorityDigest:digest({role,core,memberships,schema}),rndPrivileges};
}
export function assertMinimalPrivileges(state) {
 for(const row of state.rndPrivileges)if(row.allowed!==(RECEIPT_TABLES.includes(row.name)&&['SELECT','INSERT'].includes(row.privilege)))fail('RUNTIME_RND_PRIVILEGES_MISMATCH');
 if(state.rndPrivileges.length!==state.tables.length*PRIVILEGES.length)fail('RUNTIME_RND_PRIVILEGES_MISMATCH');
}
export function inspectionReceipt(state,source,compatibleImage,now=new Date()) {
 if(!/^[a-f0-9]{40}$/.test(source??''))fail('REVIEWED_SOURCE_REQUIRED');
 if(!/^sha256:[a-f0-9]{64}$/.test(compatibleImage??''))fail('COMPATIBILITY_IMAGE_REQUIRED');
 const receipt={schemaVersion:'packproof.rnd-migration-inspection.v1',inspectedAt:now.toISOString(),source,compatibleImage,baselineCount:77,migrations:MIGRATIONS,state};
 return {...receipt,inspectionSha256:digest(receipt)};
}
export function validateInspection(receipt,state,source,compatibleImage,now=new Date()) {
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))fail('INSPECTION_REQUIRED');
 const {inspectionSha256,...body}=receipt;
 if(inspectionSha256!==digest(body)||receipt.schemaVersion!=='packproof.rnd-migration-inspection.v1'||receipt.source!==source||receipt.compatibleImage!==compatibleImage||receipt.baselineCount!==77||digest(receipt.migrations)!==digest(MIGRATIONS))fail('INSPECTION_BINDING_MISMATCH');
 const age=now.getTime()-Date.parse(receipt.inspectedAt);
 if(!Number.isFinite(age)||age<0||age>900000)fail('INSPECTION_EXPIRED');
 if(digest(receipt.state)!==digest(state))fail('INSPECTION_STATE_CHANGED');
}
export async function applyInTransaction(tx,inventory,receipt,{source,compatibleImage,runtime=PRODUCTION_RUNTIME_ROLE,splitSqlStatements,now=new Date()}) {
 await tx.query("SET LOCAL lock_timeout='5s'");await tx.query("SET LOCAL statement_timeout='30s'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
 await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
 await tx.query('LOCK TABLE public.schema_migrations IN SHARE ROW EXCLUSIVE MODE');
 const before=await inspectState(tx,inventory,runtime);validateInspection(receipt,before,source,compatibleImage,now);
 if(!before.pending){assertMinimalPrivileges(before);return {...before,alreadyApplied:true};}
 for(const pin of MIGRATIONS){const item=inventory.find(row=>row.id===pin.id);for(const statement of splitSqlStatements(item.sql))await tx.query(statement);await tx.query("INSERT INTO public.schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[item.id,now.toISOString(),item.checksum]);}
 const expected=expectedObjects(inventory);
 for(const table of expected.tables)await tx.query(`REVOKE ALL PRIVILEGES ON TABLE public.${quote(table)} FROM PUBLIC,${quote(runtime)}`);
 for(const table of RECEIPT_TABLES)await tx.query(`GRANT SELECT,INSERT ON TABLE public.${quote(table)} TO ${quote(runtime)}`);
 for(const fn of expected.functions)await tx.query(`REVOKE ALL PRIVILEGES ON FUNCTION public.${quote(fn)}() FROM PUBLIC,${quote(runtime)}`);
 const after=await inspectState(tx,inventory,runtime);assertMinimalPrivileges(after);
 if(after.pending||after.appliedCount!==86||after.runtimeAuthorityDigest!==before.runtimeAuthorityDigest)fail('FINAL_PRESERVATION_MISMATCH');
 return {...after,alreadyApplied:false};
}

async function identity(db,login) {
 const row=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database')).rows[0];
 const tls=(await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
 if(row?.role!=='packproof'||row.login!==login||row.database!=='packproof_v2'||!tls?.ssl)fail('OWNER_IDENTITY_TLS_MISMATCH');
}
export async function run(mode,env) {
 if(!['--inspect','--apply'].includes(mode)||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD)fail('EXPLICIT_OWNER_OPERATOR_REQUIRED');
 const source=env.PACKPROOF_RELEASE_SHA,compatibleImage=env.PACKPROOF_COMPATIBILITY_IMAGE_DIGEST;
 inspectionReceipt({},source,compatibleImage); // Reject missing release pins before any connection.
 let receipt;
 if(mode==='--apply'){try{receipt=JSON.parse(env.PACKPROOF_RND_INSPECTION_JSON??'');}catch{fail('INSPECTION_REQUIRED');}if(receipt.inspectionSha256!==env.PACKPROOF_RND_INSPECTION_SHA256)fail('INSPECTION_BINDING_MISMATCH');}
 const [{default:pg},{loadConfig},{createPgDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([import('pg'),import('../dist/config.js'),import('../dist/db/postgres.js'),import('../dist/db/migrate.js'),import('../dist/db/sql.js')]);
 const config=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(config.databaseUrl);
 if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2'||(url.port&&url.port!=='5432'))fail('DATABASE_TARGET_MISMATCH');
 const owner=createPgDatabase(config.databaseUrl,undefined,env);let temporary=null,separate=null,cleanupFailed=false;
 try {
  const inventory=await migrationInventory();
  const before=await owner.db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');await tx.query("SET LOCAL statement_timeout='30s'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");await tx.query("SET LOCAL lock_timeout='5s'");await identity(tx,'packproof');return inspectState(tx,inventory,PRODUCTION_RUNTIME_ROLE);});
  if(mode==='--inspect'){if(!before.pending)assertMinimalPrivileges(before);const result=inspectionReceipt(before,source,compatibleImage);console.log(JSON.stringify({event:'rnd_migration_inspected',inspection:result}));return result;}
  validateInspection(receipt,before,source,compatibleImage);
  const name='pp_rnd_migrate_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64'),server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
  await owner.db.transaction(async tx=>{await tx.query(`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);await tx.query(`GRANT packproof TO ${pg.escapeIdentifier(name)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);});
  temporary=name;url.username=name;url.password=password;url.searchParams.set('options','-c role=packproof');separate=createPgDatabase(url.toString(),undefined,env);
  const after=await separate.db.transaction(async tx=>{await identity(tx,name);return applyInTransaction(tx,inventory,receipt,{source,compatibleImage,runtime:PRODUCTION_RUNTIME_ROLE,splitSqlStatements});});
  console.log(JSON.stringify({event:'rnd_migration_applied',source,compatibleImage,inspectionSha256:receipt.inspectionSha256,appliedCount:after.appliedCount,alreadyApplied:after.alreadyApplied,runtimeAuthorityPreserved:true,receiptTables:RECEIPT_TABLES,allowedPrivileges:['SELECT','INSERT'],advancedPrivileges:false}));
  return after;
 } finally {
  try{await separate?.close();}catch{cleanupFailed=true;}
  if(temporary)try{await owner.db.query(`DROP ROLE ${pg.escapeIdentifier(temporary)}`);}catch{cleanupFailed=true;}
  try{await owner.close();}catch{cleanupFailed=true;}
  if(cleanupFailed){console.error(JSON.stringify({event:'rnd_migration_cleanup_failed',temporaryLogin:temporary}));process.exitCode=1;}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.argv[2],process.env).catch(error=>{const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED';const sqlState=/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined;console.error(JSON.stringify({event:'rnd_migration_failed',reason,sqlState}));process.exitCode=1;});
