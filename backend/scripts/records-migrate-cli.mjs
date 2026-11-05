// Owner credentials are launch-time secret references for this one-shot task.
// They never enter an archive, argument, receipt, or exception message.
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {inspectState,inspectionReceipt,validateInspection,applyInTransaction,digest,INVENTORY_DIGEST} from './records-migrate.mjs';
const productionHost='packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com';
const fail=code=>{throw Error(code);};

export function qualifiedRehearsal(env,binding,now=new Date()){
 let report;try{report=JSON.parse(env.PACKPROOF_RECORDS_REHEARSAL_JSON??'');}catch{fail('RECORDS_REHEARSAL_REQUIRED');}
 const {sha256,...body}=report??{};
 if(sha256!==digest(body)||sha256!==env.PACKPROOF_RECORDS_REHEARSAL_SHA256||body.schema!=='packproof.records-release-rehearsal/v1'||body.source!==binding.source||body.compatibleImage!==binding.compatibleImage||body.inventorySha256!==INVENTORY_DIGEST||body.sourceDatabase!=='packproof-v2-staging-db'||!/^packproof-records-release-[a-z0-9-]+\.c8v2esku2zyt\.us-east-1\.rds\.amazonaws\.com$/.test(body.restoredHost??''))fail('RECORDS_REHEARSAL_BINDING_MISMATCH');
 if(body.migrationExitCode!==0||body.bridgeExitCode!==0||body.baselinePreserved!==true||body.runtimeAuthorityPreserved!==true||!Array.isArray(body.taskArns)||body.taskArns.length<2||body.taskArns.some(arn=>!/^arn:aws:ecs:us-east-1:784514617543:task\/packproof-v2-staging-cluster\/[a-f0-9]{32}$/.test(arn)))fail('RECORDS_REHEARSAL_NOT_QUALIFIED');
 const age=now.getTime()-Date.parse(body.completedAt);if(!Number.isFinite(age)||age<0||age>86400000)fail('RECORDS_REHEARSAL_EXPIRED');
 return sha256;
}

export async function run(mode,env){
 if(!['--inspect','--apply','--rehearse'].includes(mode)||env.PACKPROOF_DB_USER!=='packproof'||!env.PACKPROOF_DB_PASSWORD)fail('RECORDS_EXPLICIT_OWNER_OPERATOR_REQUIRED');
 const rehearsal=mode==='--rehearse';
 if(env.PACKPROOF_OPERATOR_PURPOSE!==(rehearsal?'records-restored-migration-rehearsal':'records-inactive-production-migration')||env.PACKPROOF_ENVIRONMENT!=='production'||env.PACKPROOF_MIGRATE_ON_START!=='false'||env.PACKPROOF_ORGANIZATIONS_ENABLED!=='false'||env.PACKPROOF_CLAIM_EXPORTS_ENABLED!=='false')fail('RECORDS_INACTIVE_OPERATOR_CONFIGURATION_REQUIRED');
 const binding={source:env.PACKPROOF_RELEASE_SHA,compatibleImage:env.PACKPROOF_COMPATIBILITY_IMAGE_DIGEST,compatibilityEvidenceSha256:env.PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256,rehearsalSha256:env.PACKPROOF_RECORDS_REHEARSAL_SHA256};
 if(!rehearsal){binding.rehearsalSha256=qualifiedRehearsal(env,binding);inspectionReceipt({},binding);}
 const [{default:pg},{loadConfig},{createPgDatabase},{migrationInventory},{splitSqlStatements}]=await Promise.all([
  import('pg'),import('../dist/config.js'),import('../dist/db/postgres.js'),import('../dist/db/migrate.js'),import('../dist/db/sql.js')]);
 const config=loadConfig({...env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(config.databaseUrl);
 if(url.pathname!=='/packproof_v2'||url.port&&url.port!=='5432'||(rehearsal?!/^packproof-records-release-[a-z0-9-]+\.c8v2esku2zyt\.us-east-1\.rds\.amazonaws\.com$/.test(url.hostname):url.hostname!==productionHost))fail('RECORDS_DATABASE_TARGET_MISMATCH');
 const runtimeRole='packproof_app_runtime_v1',owner=createPgDatabase(url.toString(),undefined,env);
 let separate,temporary,cleanupFailed=false;
 const identity=async(db,login)=>{
  const row=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(row?.role!=='packproof'||row.login!==login||row.database!=='packproof_v2'||row.schema!=='public'||!tls?.ssl)fail('RECORDS_OWNER_IDENTITY_TLS_MISMATCH');
  return {role:row.role,login:row.login,tls:tls.version};
 };
 try{
  const inventory=await migrationInventory();
  const before=await owner.db.transaction(async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query("SET LOCAL statement_timeout='30s'");
   await identity(tx,'packproof');return inspectState(tx,inventory,runtimeRole);
  });
  if(rehearsal){
   // This binds the rehearsal's input state. Only the later independent bridge
   // task plus this successful migration can produce a production qualification.
   binding.rehearsalSha256=digest({purpose:'restored-migration-input',source:binding.source,host:url.hostname,state:before});
  }
  let receipt;
  if(mode==='--apply'){
   try{receipt=JSON.parse(env.PACKPROOF_RECORDS_INSPECTION_JSON??'');}catch{fail('RECORDS_INSPECTION_REQUIRED');}
   if(receipt.inspectionSha256!==env.PACKPROOF_RECORDS_INSPECTION_SHA256)fail('RECORDS_INSPECTION_BINDING_MISMATCH');
   validateInspection(receipt,before,binding);
  }else receipt=inspectionReceipt(before,binding);
  if(mode==='--inspect'){console.log(JSON.stringify({event:'records_migration_inspected',inspection:receipt}));return receipt;}
  const name='pp_records_migrate_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const stored=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64'),server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
  await owner.db.transaction(async tx=>{
   await tx.query(`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(new Date(Date.now()+900000).toISOString())}`);
   await tx.query(`GRANT packproof TO ${pg.escapeIdentifier(name)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
  });
  temporary=name;url.username=name;url.password=password;url.searchParams.set('options','-c role=packproof');separate=createPgDatabase(url.toString(),undefined,env);
  const after=await separate.db.transaction(async tx=>{await identity(tx,name);return applyInTransaction(tx,inventory,receipt,{...binding,runtimeRole,splitSqlStatements});});
  const report={event:rehearsal?'records_restored_migration_applied':'records_migration_applied',...binding,inspectionSha256:receipt.inspectionSha256,appliedCount:after.appliedCount,alreadyApplied:after.alreadyApplied,baselinePreserved:before.baselineDataSha256===after.baselineDataSha256&&before.baselineCatalogSha256===after.baselineCatalogSha256,runtimeAuthorityPreserved:before.baselineAuthoritySha256===after.baselineAuthoritySha256,inventorySha256:after.inventorySha256,baselineDataSha256:after.baselineDataSha256,baselineCatalogSha256:after.baselineCatalogSha256,...(rehearsal?{restoredHost:url.hostname}:{})};
  console.log(JSON.stringify(report));return report;
 }finally{
  try{await separate?.close();}catch{cleanupFailed=true;}
  if(temporary)try{await owner.db.query(`DROP ROLE ${pg.escapeIdentifier(temporary)}`);}catch{cleanupFailed=true;}
  try{await owner.close();}catch{cleanupFailed=true;}
  if(cleanupFailed){console.error(JSON.stringify({event:'records_migration_cleanup_failed',temporaryLogin:temporary}));process.exitCode=1;}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.argv[2],process.env).catch(error=>{
 const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'DATABASE_OPERATION_FAILED';
 const sqlState=/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:undefined;
 console.error(JSON.stringify({event:'records_migration_failed',reason,sqlState}));process.exitCode=1;
});
