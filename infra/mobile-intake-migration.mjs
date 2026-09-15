/**
 * Controlled, one-shot mobile intake migration runner.
 * Run against the pinned candidate container; never start the application here.
 * --inspect is read-only. --apply borrows only the existing fixed owner role through
 * a separate, short-lived login and invokes the repository's normal migration CLI.
 */
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const OWNER_ROLE='packproof';
export const MIGRATIONS=Object.freeze({
  '067_mobile_intake_submissions':'3f1333e6f4670e9506ab0ad0970fa83373f2c243175fef247fe99dd0616b923c',
  '068_commerce_sync_checkpoints':'1a9c3cacf5f146f87dd1fe5ae125aceb9ee5c36ee971cb0e4fad6c9053133a51',
});
const NEW_TABLES=['intake_scoped_sessions','intake_submissions','commerce_sync_page_checkpoints'];
const ROLE_PATTERN=/^pp_intake_migrate_[0-9a-f]{16}$/;
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code});};

export function validateInventory(inventory,applied){
  const files=new Map(inventory.map(row=>[row.id,row]));
  if(files.size!==inventory.length||new Set(applied.map(row=>row.id)).size!==applied.length)fail('DUPLICATE_MIGRATION_ID');
  for(const [id,hash] of Object.entries(MIGRATIONS))if(files.get(id)?.checksum!==hash)fail('INTAKE_MIGRATION_SOURCE_MISMATCH');
  for(const row of applied)if(!files.has(row.id)||files.get(row.id).checksum!==row.checksum)fail('MIGRATION_BASELINE_MISMATCH');
  const existing=new Set(applied.map(row=>row.id));
  const missing=inventory.filter(row=>!existing.has(row.id));
  if(missing.some(row=>!Object.hasOwn(MIGRATIONS,row.id)))fail('UNEXPECTED_PENDING_MIGRATION');
  return missing.map(row=>row.id);
}

export function temporaryDatabaseEnvironment(env,databaseUrl,login,password){
  if(!ROLE_PATTERN.test(login))fail('INVALID_TEMPORARY_LOGIN');
  const url=new URL(databaseUrl);
  if(decodeURIComponent(url.username)!==OWNER_ROLE)fail('DATABASE_OWNER_MISMATCH');
  url.username=login;url.password=password;url.searchParams.set('options',`-c role=${OWNER_ROLE} -c statement_timeout=30000 -c lock_timeout=15000`);
  const child={...env,PACKPROOF_MIGRATION_DATABASE_URL:url.toString(),DATABASE_URL:url.toString(),PACKPROOF_MIGRATION_ROLE:OWNER_ROLE};
  // The runtime master-secret callback must never replace the temporary login's password.
  delete child.PACKPROOF_DB_SECRET_ARN;
  delete child.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS;
  return child;
}

export async function withTemporaryAuthority({create,grant,run,cleanup}){
  let created=false;
  try{await create();created=true;await grant();return await run();}
  finally{if(created)await cleanup();}
}

function runNormalMigrator(env,signal){
  return new Promise((resolve,reject)=>{
    let failed=false;
    const child=spawn(process.execPath,['dist/db/migrate-cli.js'],{cwd:'/app',env,stdio:'ignore',timeout:180000,killSignal:'SIGTERM',signal});
    // Abort emits error before close. Wait for close before dropping its login.
    child.once('error',()=>{failed=true;});
    child.once('close',code=>code===0&&!failed?resolve():reject(Object.assign(new Error('CONTROLLED_MIGRATOR_FAILED'),{safeCode:'CONTROLLED_MIGRATOR_FAILED'})));
  });
}

export async function main(args=process.argv.slice(2)){
  if(args.length!==2||!['--inspect','--apply'].includes(args[0])||!/^[a-f0-9]{40}$/.test(args[1]))fail('EXPECTED_MODE_AND_SOURCE_SHA');
  const [mode,expectedSource]=args;
  const [{loadConfig},{openDatabase},{createPgDatabase},{migrationInventory,assertSchemaCurrent},{default:pg}]=await Promise.all([
    import('/app/dist/config.js'),import('/app/dist/db/open.js'),import('/app/dist/db/postgres.js'),import('/app/dist/db/migrate.js'),import('/app/node_modules/pg/lib/index.js'),
  ]);
  const config=loadConfig();
  if(config.release.commit!==expectedSource||config.release.environment!=='staging'||config.migrateOnStart)fail('RELEASE_CONTEXT_MISMATCH');
  if(!config.databaseUrl||decodeURIComponent(new URL(config.databaseUrl).username)!==OWNER_ROLE)fail('DATABASE_OWNER_MISMATCH');
  const opened=await openDatabase(config),abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let phase='inspect',temporaryLogin=null,cleanupRequired=false;
  const transaction=work=>opened.db.transaction(async db=>{
    await db.query("SET LOCAL statement_timeout='30s'");await db.query("SET LOCAL lock_timeout='15s'");return work(db);
  });
  try{
    const inventory=await migrationInventory();
    const baseline=await transaction(async db=>{
      await db.query('SET TRANSACTION READ ONLY');
      const identity=(await db.query('SELECT current_user AS role,session_user AS login')).rows[0];
      if(identity.role!==OWNER_ROLE||identity.login!==OWNER_ROLE)fail('MIGRATION_OWNER_MISMATCH');
      const owner=(await db.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='schema_migrations'")).rows[0];
      if(owner?.tableowner!==OWNER_ROLE)fail('MIGRATION_TABLE_OWNER_MISMATCH');
      const required=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
      if(!required||required.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
      const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
      return{identity,missing:validateInventory(inventory,applied),appliedCount:applied.length};
    });
    console.log(JSON.stringify({event:'mobile_intake_migration_preflight',sourceSha:expectedSource,mode,...baseline}));
    if(mode==='--inspect')return;
    if(abort.signal.aborted)fail('MIGRATION_INTERRUPTED');
    if(baseline.missing.length){
      phase='temporary_authority';
      temporaryLogin=`pp_intake_migrate_${randomBytes(8).toString('hex')}`;
      const password=randomBytes(32).toString('hex'),salt=randomBytes(24),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
      const storedKey=createHash('sha256').update(createHmac('sha256',salted).update('Client Key').digest()).digest('base64');
      const serverKey=createHmac('sha256',salted).update('Server Key').digest('base64');
      const verifier=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
      const expires=new Date(Date.now()+15*60000).toISOString();
      const role=pg.escapeIdentifier(temporaryLogin);
      await withTemporaryAuthority({
        create:()=>transaction(db=>db.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD ${pg.escapeLiteral(verifier)} VALID UNTIL ${pg.escapeLiteral(expires)}`)),
        grant:()=>transaction(async db=>{
          // Standard PostgreSQL16 CREATEROLE can add a reverse creator membership.
          // The verified RDS master does not. Fail rather than create a cycle or
          // alter runtime-role memberships if that managed behavior changes.
          const reverse=(await db.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname=$1 AND member.rolname=$2',[temporaryLogin,OWNER_ROLE])).rows;
          if(reverse.length)fail('MIGRATION_AUTHORITY_TOPOLOGY_CHANGED');
          await db.query(`GRANT ${pg.escapeIdentifier(OWNER_ROLE)} TO ${role} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
          const binding=(await db.query('SELECT m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE parent.rolname=$1 AND member.rolname=$2',[OWNER_ROLE,temporaryLogin])).rows[0];
          if(!binding||binding.admin_option!==false||binding.inherit_option!==false||binding.set_option!==true)fail('MIGRATION_AUTHORITY_SCOPE_MISMATCH');
        }),
        run:async()=>{
          const env=temporaryDatabaseEnvironment(process.env,config.databaseUrl,temporaryLogin,password);
          const separate=createPgDatabase(env.DATABASE_URL,undefined,env);
          try{
            const identity=(await separate.db.query('SELECT current_user AS role,session_user AS login')).rows[0];
            if(identity.role!==OWNER_ROLE||identity.login!==temporaryLogin)fail('SEPARATE_LOGIN_VERIFICATION_FAILED');
          }finally{await separate.close();}
          phase='controlled_migration';
          await runNormalMigrator(env,abort.signal);
        },
        cleanup:async()=>{
          try{
            // All DDL ran as the fixed owner: the temporary login must own nothing.
            // DROP ROLE refuses outstanding owned objects; never REASSIGN or DROP OWNED.
            await transaction(db=>db.query(`DROP ROLE ${role}`));
            console.log(JSON.stringify({event:'mobile_intake_migration_login_removed'}));
          }catch{cleanupRequired=true;fail('TEMPORARY_LOGIN_CLEANUP_REQUIRED');}
        },
      });
    }
    phase='verify';await assertSchemaCurrent(opened.db);
    const verification=await transaction(async db=>{
      await db.query('SET TRANSACTION READ ONLY');
      const applied=(await db.query('SELECT id,checksum,checksum_provenance FROM schema_migrations WHERE id=ANY($1::text[]) ORDER BY id',[Object.keys(MIGRATIONS)])).rows;
      if(applied.length!==2||applied.some(row=>row.checksum!==MIGRATIONS[row.id]||row.checksum_provenance!=='EXECUTED_BYTES'))fail('MIGRATION_RECEIPT_MISMATCH');
      const tables=(await db.query("SELECT tablename,tableowner FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename",[NEW_TABLES])).rows;
      if(tables.length!==3||tables.some(row=>row.tableowner!==OWNER_ROLE))fail('NEW_TABLE_OWNER_MISMATCH');
      for(const name of NEW_TABLES)for(const privilege of ['SELECT','INSERT','UPDATE','DELETE']){
        const access=(await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[OWNER_ROLE,`public.${name}`,privilege])).rows[0];
        if(access?.allowed!==true)fail('RUNTIME_TABLE_PRIVILEGE_MISMATCH');
      }
      const policy=(await db.query('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
      if(policy?.durability_required!==(config.requireDurableReceipts===true))fail('DURABILITY_POLICY_MISMATCH');
      return{applied,tables,migrationCount:inventory.length};
    });
    console.log(JSON.stringify({event:'mobile_intake_migration_verified',sourceSha:expectedSource,separateLogin:baseline.missing.length>0,...verification}));
  }catch(error){
    console.log(JSON.stringify({event:'mobile_intake_migration_failed',phase,code:error?.safeCode??'MIGRATION_FAILED',...(cleanupRequired?{cleanupRequired:true,temporaryLogin}:{})}));
    process.exitCode=1;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await opened.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.log(JSON.stringify({event:'mobile_intake_migration_failed',code:'PREFLIGHT_FAILED'}));process.exitCode=1;});
}
