// Run the immutable bridge as the existing actual runtime login, only against
// the isolated restored database. No server, worker, owner login or real capture.
import {createHash} from 'node:crypto';
import {loadConfig} from '/app/backend/dist/config.js';
import {createPgDatabase} from '/app/backend/dist/db/postgres.js';
import {assertSchemaCurrent} from '/app/backend/dist/db/migrate.js';
import {insertUser} from '/app/backend/dist/domain/users.js';
import {createTransaction} from '/app/backend/dist/domain/transactions.js';
import {createOrGetProof} from '/app/backend/dist/domain/create-proof.js';
import {createCaptureSession} from '/app/backend/dist/domain/capture-sessions.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let opened;
try{
 const [source,image,stage]=process.argv.slice(2);
 if(process.argv.length!==5||!/^[a-f0-9]{40}$/.test(source??'')||!/^sha256:[a-f0-9]{64}$/.test(image??'')||!['baseline','upgraded'].includes(stage)||process.env.PACKPROOF_RELEASE_SHA!==source)throw Error('RECORDS_BRIDGE_PREFLIGHT_BINDING_REQUIRED');
 const config=loadConfig({...process.env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''}),url=new URL(config.databaseUrl);
 if(!/^packproof-records-release-[a-z0-9-]+\.c8v2esku2zyt\.us-east-1\.rds\.amazonaws\.com$/.test(url.hostname)||url.pathname!=='/packproof_v2'||decodeURIComponent(url.username)!=='packproof_app_runtime_v1'||config.migrateOnStart!==false)throw Error('RECORDS_BRIDGE_RESTORED_TARGET_REQUIRED');
 opened=createPgDatabase(url.toString(),undefined,process.env);
 const receipt=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='30s'");
  const identity=(await db.query('SELECT current_user AS role,session_user AS login,current_database() AS database,current_schema() AS schema')).rows[0];
  const tls=(await db.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  if(identity?.role!=='packproof_app_runtime_v1'||identity.login!==identity.role||identity.database!=='packproof_v2'||identity.schema!=='public'||!tls?.ssl)throw Error('RECORDS_BRIDGE_RUNTIME_IDENTITY_TLS_MISMATCH');
  await assertSchemaCurrent(db);
  const rows=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  const expected=stage==='baseline'?{count:94,sha256:'1f9acaaa62fc4f3f19bf4af6331b94053d9662587d461d29d74900c6d5f896b9'}:{count:106,sha256:'605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1'};
  if(rows.length!==expected.count||hash(rows)!==expected.sha256)throw Error('RECORDS_BRIDGE_LEDGER_MISMATCH');
  return {source,image,stage,identity,tls:{ssl:tls.ssl,version:tls.version},restoredHost:url.hostname,appliedCount:rows.length,appliedSha256:hash(rows),inactiveM2ChecksPassed:true};
 });
 const rollback=Symbol('intentional synthetic transaction rollback'),clock={now:()=>new Date()};
 let actor,proofId,issued=false;
 try{await opened.db.transaction(async db=>{
  actor=await insertUser(db,clock);
  const transaction=await createTransaction(db,clock,actor,{itemTitle:'Synthetic records bridge rehearsal'});
  proofId=(await createOrGetProof(db,clock,actor,transaction.transactionId)).proofId;
  issued=(await createCaptureSession(db,clock,actor,proofId,{client:'WEB_CAMERA',idempotencyKey:'synthetic-records-bridge-rehearsal'})).state==='ISSUED';
  if(!issued)throw Error('RECORDS_BRIDGE_CAPTURE_ADMISSION_FAILED');
  throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 if(!issued||(await opened.db.query('SELECT 1 FROM users WHERE id=$1',[actor])).rows.length||(await opened.db.query('SELECT 1 FROM proofs WHERE id=$1',[proofId])).rows.length)throw Error('RECORDS_BRIDGE_SYNTHETIC_ROLLBACK_FAILED');
 console.log(JSON.stringify({event:'records_inactive_bridge_preflight',...receipt,legacyAccountProofCaptureAdmission:true,syntheticTransactionRolledBack:true,evidenceCaptured:false}));
}catch(error){
 const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'RECORDS_BRIDGE_PREFLIGHT_REVIEW_REQUIRED';
 console.error(JSON.stringify({event:'records_inactive_bridge_preflight_failed',code}));process.exitCode=1;
}finally{await opened?.close();}
