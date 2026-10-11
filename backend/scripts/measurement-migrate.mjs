// Copy unchanged to backend/scripts/measurement-migrate.mjs in the reviewed image.
// One-shot 076 only: no general migrator, analytics setup, or runtime grants.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MIGRATION = Object.freeze({id:'076_first_experience_measurement',checksum:'3b80452692918bb3589500d100b773deeb8cddf3c57b6882796e8cd1a13c1157'});
const COLUMN_NAMES=['flow_version','app_version','platform','entry_source','client_occurred_at','network_state','upload_state'];
const fail=code=>{throw new Error(code);};
export function inspectInventory(inventory, applied) {
  if(inventory.length!==77||new Set(inventory.map(row=>row.id)).size!==77)fail('CANDIDATE_INVENTORY_MISMATCH');
  const migration=inventory.find(row=>row.id===MIGRATION.id);
  if(!migration||migration.checksum!==MIGRATION.checksum||createHash('sha256').update(migration.sql).digest('hex')!==MIGRATION.checksum)fail('MIGRATION_BYTES_MISMATCH');
  if(![76,77].includes(applied.length)||new Set(applied.map(row=>row.id)).size!==applied.length)fail('APPLIED_INVENTORY_MISMATCH');
  const expected=new Map(inventory.map(row=>[row.id,row.checksum]));
  if(applied.some(row=>expected.get(row.id)!==row.checksum))fail('APPLIED_CHECKSUM_MISMATCH');
  const actual=new Map(applied.map(row=>[row.id,row.checksum]));
  if(inventory.some(row=>row.id!==MIGRATION.id&&actual.get(row.id)!==row.checksum))fail('BASELINE_RECEIPT_MISSING');
  const pending=!actual.has(MIGRATION.id);
  if(pending!== (applied.length===76))fail('APPLIED_INVENTORY_MISMATCH');
  return {pending,migration};
}

async function inspectSchema(db,pending) {
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='program_timing_events' AND column_name=ANY($1::text[])",[COLUMN_NAMES])).rows;
  const index=(await db.query("SELECT to_regclass('public.program_first_experience_starts') IS NOT NULL AS present")).rows[0];
  if(pending&&(columns.length!==0||index?.present))fail('UNRECEIPTED_MEASUREMENT_SCHEMA');
  if(!pending&&(columns.length!==7||!index?.present))fail('RECEIPTED_MEASUREMENT_SCHEMA_MISMATCH');
}
async function inspect(db,inventory,login) {
  const identity=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database')).rows[0];
  const tls=(await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(identity?.role!=='packproof'||identity.login!==login||identity.database!=='packproof_v2'||!tls?.ssl)fail('OWNER_IDENTITY_TLS_MISMATCH');
  const applied=(await db.query('SELECT id,checksum FROM public.schema_migrations ORDER BY id')).rows;
  const state=inspectInventory(inventory,applied);
  await inspectSchema(db,state.pending);
  return {...state,baselineCount:applied.length};
}
async function boundedTransaction(db,fn) {
  return db.transaction(async tx=>{
    await tx.query("SET LOCAL lock_timeout='5s'");
    await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,1)');
    return fn(tx);
  });
}

export async function run(mode,env) {
  if(!['--inspect','--apply'].includes(mode)||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD)fail('EXPLICIT_OWNER_OPERATOR_REQUIRED');
  if(env.PACKPROOF_MEASUREMENT_MIGRATION_SHA256!==MIGRATION.checksum||!/^([a-f0-9]{40})$/.test(env.PACKPROOF_RELEASE_SHA??''))fail('REVIEWED_SOURCE_REQUIRED');
  // This records the operator's separately verified, ready-compatible rollback image.
  if(!/^sha256:[a-f0-9]{64}$/.test(env.PACKPROOF_COMPATIBILITY_IMAGE_DIGEST??''))fail('COMPATIBILITY_IMAGE_REQUIRED');
  const [{default:pg},{loadConfig},{createPgDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([
    import('pg'),import('../dist/config.js'),import('../dist/db/postgres.js'),import('../dist/db/migrate.js'),import('../dist/db/sql.js'),
  ]);
  const config=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(config.databaseUrl);
  if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2'||(url.port&&url.port!=='5432'))fail('DATABASE_TARGET_MISMATCH');
  const owner=createPgDatabase(config.databaseUrl,undefined,env);
  let temporary=null,separate=null,cleanupFailed=false;
  try {
    const inventory=await migrationInventory();
    const before=await boundedTransaction(owner.db,tx=>inspect(tx,inventory,'packproof'));
    console.log(JSON.stringify({event:'measurement_migration_inspected',pending:before.pending,source:env.PACKPROOF_RELEASE_SHA,migrationSha256:MIGRATION.checksum,baselineCount:before.baselineCount,compatibleImage:env.PACKPROOF_COMPATIBILITY_IMAGE_DIGEST,tls:true}));
    if(mode==='--inspect')return;
    if(before.pending) {
      const name='pp_measure_migrate_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex');
      const salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
      const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
      const server=createHmac('sha256',salted).update('Server Key').digest('base64');
      const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
      await boundedTransaction(owner.db,async tx=>{
        await tx.query(`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);
        await tx.query(`GRANT packproof TO ${pg.escapeIdentifier(name)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      });
      temporary=name;
      url.username=name;url.password=password;url.searchParams.set('options','-c role=packproof');
      separate=createPgDatabase(url.toString(),undefined,env);
      await boundedTransaction(separate.db,async tx=>{
        await tx.query('LOCK TABLE public.schema_migrations IN SHARE ROW EXCLUSIVE MODE');
        const current=await inspect(tx,inventory,name);
        if(!current.pending)return;
        await tx.query('LOCK TABLE public.program_timing_events IN ACCESS EXCLUSIVE MODE');
        // These are only the bytes whose digest is pinned above. Receipt and DDL
        // share this transaction, so a timeout cannot leave a partial migration.
        for(const statement of splitSqlStatements(current.migration.sql))await tx.query(statement);
        await tx.query("INSERT INTO public.schema_migrations(id,applied_at,checksum,checksum_provenance) VALUES($1,$2,$3,'EXECUTED_BYTES')",[MIGRATION.id,new Date().toISOString(),MIGRATION.checksum]);
        const final=await inspect(tx,inventory,name);
        if(final.pending||final.baselineCount!==77)fail('FINAL_INVENTORY_MISMATCH');
      });
    }
    const after=await boundedTransaction(owner.db,tx=>inspect(tx,inventory,'packproof'));
    if(after.pending||after.baselineCount!==77)fail('FINAL_INVENTORY_MISMATCH');
    console.log(JSON.stringify({event:'measurement_migration_applied',migrationSha256:MIGRATION.checksum,appliedCount:77,alreadyApplied:!before.pending}));
  } finally {
    try {await separate?.close();}catch {cleanupFailed=true;}
    if(temporary)try {await owner.db.query(`DROP ROLE ${pg.escapeIdentifier(temporary)}`);}catch {cleanupFailed=true;}
    try {await owner.close();}catch {cleanupFailed=true;}
    if(cleanupFailed){console.error(JSON.stringify({event:'measurement_migration_cleanup_failed',temporaryLogin:temporary}));process.exitCode=1;}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  run(process.argv[2],process.env).catch(error=>{
    const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED';
    const sqlState=/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined;
    console.error(JSON.stringify({event:'measurement_migration_failed',reason,sqlState}));process.exitCode=1;
  });
}
