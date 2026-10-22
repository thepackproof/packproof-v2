// Read-only owner-injected post-inspection; never starts the API or any worker.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const at=name=>import(pathToFileURL(path.join(process.cwd(),name)).href);
let opened;
try{
 const {run}=await at('scripts/m2-migrate-cli.mjs');
 const receipt=await run('--inspect',process.env);
 assert.equal(receipt.state.pending,false);assert.equal(receipt.state.appliedCount,94);
 const {loadConfig}=await at('dist/config.js'),{createPgDatabase}=await at('dist/db/postgres.js');
 const config=loadConfig({...process.env,DATABASE_URL:'',PACKPROOF_DB_SECRET_ARN:''});
 opened=createPgDatabase(config.databaseUrl,undefined,process.env);
 const result=await opened.db.transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='5s'");
  const identity=(await db.query("SELECT current_user AS role,session_user AS login,current_setting('transaction_read_only') AS read_only")).rows[0];
  assert.equal(identity.role,'packproof');assert.equal(identity.login,'packproof');assert.equal(identity.read_only,'on');
  const roles=(await db.query("SELECT COUNT(*) AS count FROM pg_roles WHERE rolname ~ '^pp_m2_migrate_[0-9a-f]{16}$'")).rows[0];
  assert.equal(Number(roles.count),0);return {temporaryMigrationRoles:0,readOnly:true};
 });
 console.log(JSON.stringify({event:'m2_migration_cleanup_verified',status:'PASSED',...result,inspectionSha256:receipt.inspectionSha256,observedAt:new Date().toISOString()}));
}catch{console.error(JSON.stringify({event:'m2_migration_post_inspection_failed'}));process.exitCode=1;}
finally{await opened?.close();}
