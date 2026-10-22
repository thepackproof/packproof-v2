// Owner-secret injection is limited to this short-lived operator process.
// No owner credential, connection string or SQL exception text is emitted.
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {inspectState,inspectionReceipt,validateInspection,applyInTransaction} from './m2-migrate.mjs';
const fail=code=>{throw Error(code);};
export async function run(mode,env){
 if(!['--inspect','--apply'].includes(mode)||env.PACKPROOF_OPERATOR_PURPOSE!=='m2-inactive-production-migration'||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD)fail('EXPLICIT_OWNER_OPERATOR_REQUIRED');
 if(env.PACKPROOF_ENVIRONMENT!=='production'||env.PACKPROOF_MIGRATE_ON_START!=='false')fail('PRODUCTION_OPERATOR_CONFIGURATION_REQUIRED');
 if(env.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false')fail('M2_INACTIVE_FEATURES_REQUIRED');
 const source=env.PACKPROOF_RELEASE_SHA,compatibleImage=env.PACKPROOF_COMPATIBILITY_IMAGE_DIGEST,compatibilityEvidenceSha256=env.PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256;
 const binding={source,compatibleImage,compatibilityEvidenceSha256},runtimeRoles=['packproof_app_runtime_v1'];
 inspectionReceipt({},binding);
 let receipt;
 if(mode==='--apply'){
  try{receipt=JSON.parse(env.PACKPROOF_M2_INSPECTION_JSON??'');}catch{fail('INSPECTION_REQUIRED');}
  if(receipt.inspectionSha256!==env.PACKPROOF_M2_INSPECTION_SHA256)fail('INSPECTION_BINDING_MISMATCH');
 }
 const [{default:pg},{loadConfig},{createPgDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([
  import('pg'),import('../dist/config.js'),import('../dist/db/postgres.js'),import('../dist/db/migrate.js'),import('../dist/db/sql.js')]);
 const config=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(config.databaseUrl);
 if(url.hostname!=='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com'||url.pathname!=='/packproof_v2'||(url.port&&url.port!=='5432'))fail('DATABASE_TARGET_MISMATCH');
 const owner=createPgDatabase(url.toString(),undefined,env);let temporary,separate,cleanupFailed=false;
 const identity=async(db,login)=>{
  const row=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
  const tls=(await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(row.role!=='packproof'||row.login!==login||row.database!=='packproof_v2'||row.schema!=='public'||!tls?.ssl)fail('OWNER_IDENTITY_TLS_MISMATCH');
 };
 try{
  const inventory=await migrationInventory();
  const before=await owner.db.transaction(async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query("SET LOCAL statement_timeout='30s'");
   await identity(tx,'packproof');return inspectState(tx,inventory,runtimeRoles);
  });
  if(mode==='--inspect'){
   const inspection=inspectionReceipt(before,binding);
   console.log(JSON.stringify({event:'m2_migration_inspected',inspection}));return inspection;
  }
  validateInspection(receipt,before,binding);
  const name='pp_m2_migrate_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
  await owner.db.transaction(async tx=>{
   await tx.query(`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);
   await tx.query(`GRANT packproof TO ${pg.escapeIdentifier(name)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
  });
  temporary=name;url.username=name;url.password=password;url.searchParams.set('options','-c role=packproof');
  separate=createPgDatabase(url.toString(),undefined,env);
  const after=await separate.db.transaction(async tx=>{
   await identity(tx,name);
   return applyInTransaction(tx,inventory,receipt,{...binding,runtimeRoles,splitSqlStatements});
  });
  console.log(JSON.stringify({event:'m2_migration_applied',...binding,inspectionSha256:receipt.inspectionSha256,
   appliedCount:after.appliedCount,alreadyApplied:after.alreadyApplied,runtimeAuthorityDigest:after.runtimeAuthorityDigest,frozen:after.frozen}));
  return after;
 }finally{
  try{await separate?.close();}catch{cleanupFailed=true;}
  if(temporary)try{await owner.db.query(`DROP ROLE ${pg.escapeIdentifier(temporary)}`);}catch{cleanupFailed=true;}
  try{await owner.close();}catch{cleanupFailed=true;}
  if(cleanupFailed){console.error(JSON.stringify({event:'m2_migration_cleanup_failed',temporaryLogin:temporary}));process.exitCode=1;}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.argv[2],process.env).catch(error=>{
 const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED';
 const sqlState=/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined;
 console.error(JSON.stringify({event:'m2_migration_failed',reason,sqlState}));process.exitCode=1;
});
