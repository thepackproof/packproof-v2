import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,pbkdf2Sync} from 'node:crypto';
import {PGlite} from '../../backend/node_modules/@electric-sql/pglite/dist/index.js';
import {migrate,migrationInventory} from '../../backend/dist/db/migrate.js';
import {splitSqlStatements} from '../../backend/dist/db/sql.js';
import {
  OWNER_ROLE,RUNTIME_ROLE,DATABASE_TARGET,APPLICATION_GROUPS,GROUP_ROLES,parseArguments,assertDatabaseTarget,
  ownerDatabaseEnvironment,runtimeDatabaseEnvironment,validateNewCredentials,
  scramVerifier,inventoryDigest,validateInventory,inspectAuthority,inspectObjects,
  expectedTablePrivileges,verifyRuntimePrivileges,probeDeniedAuthority,applyRuntimeRoles,
} from '../admin-runtime-credentials.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const password='A_distinct_random_runtime_password_123456789!';
const ownerUrl='postgresql://packproof:OWNER_SECRET@db.example:5432/packproof_v2?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Frds.pem&application_name=runtime-preparation';
const credentialEnv={PACKPROOF_NEW_RUNTIME_USERNAME:RUNTIME_ROLE,PACKPROOF_NEW_RUNTIME_PASSWORD:password};
const sql=await readFile(new URL('../sql/runtime-roles.sql',import.meta.url),'utf8');
const inventory=await migrationInventory();
const schemaHash=inventoryDigest(inventory);
const wrap=client=>({query:(query,params)=>client.query(query,params),transaction:work=>client.transaction(tx=>work(wrap(tx)))});
async function fixture(){
  const pg=new PGlite();await pg.waitReady;
  await pg.exec('CREATE ROLE packproof LOGIN; GRANT ALL ON SCHEMA public TO packproof; SET ROLE packproof;');
  const db=wrap(pg);await migrate(db);await pg.exec('RESET ROLE');
  return{pg,db};
}
async function baseline(db){
  const applied=(await db.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
  validateInventory(inventory,applied,schemaHash);
  return inspectObjects(db);
}
const applyArgs=db=>({db,sql,expectedSqlHash:hash(sql),splitStatements:splitSqlStatements,password,verifyBaseline:baseline,
  verifyExistingLogin:async()=>{throw Error('EXISTING_LOGIN_MUST_BE_EXPLICITLY_VERIFIED');}});

test('CLI pins mode, source, full schema, reviewed SQL and an absolute path',()=>{
  const args=['--inspect','a'.repeat(40),'b'.repeat(64),'c'.repeat(64),'/tmp/runtime-roles.sql'];
  assert.deepEqual(parseArguments(args),{mode:args[0],sourceSha:args[1],schemaSha256:args[2],rolesSqlSha256:args[3],rolesSqlPath:args[4]});
  for(const invalid of [args.slice(1),[...args,'extra'],['--deploy',...args.slice(1)],['--apply','not-a-hash',...args.slice(2)],
    [...args.slice(0,4),'relative.sql'],[...args.slice(0,4),'/tmp/name\0.sql']])assert.throws(()=>parseArguments(invalid),/EXPECTED_MODE_AND_REVIEWED_PINS/);
});

test('injected credential environment rejects ambient authority and keeps TLS settings',()=>{
  const prior={...credentialEnv,DATABASE_URL:ownerUrl,PACKPROOF_DB_SECRET_ARN:'OWNER_CALLBACK_SECRET',PACKPROOF_DB_PASSWORD:'OWNER_SECRET',
    PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'true',PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL:'OTHER_OWNER_SECRET',
    PACKPROOF_MIGRATION_DATABASE_URL:ownerUrl,PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS:'true'};
  const owner=ownerDatabaseEnvironment(prior);
  assert.equal(owner.DATABASE_URL,ownerUrl);assert.equal(owner.PACKPROOF_DB_SECRET_ARN,'');
  for(const key of ['PGUSER','PGPASSWORD','PGHOST','PGPORT','PGDATABASE','PGOPTIONS','PGSERVICE','PGSERVICEFILE','NODE_OPTIONS','NODE_PATH']){
    assert.equal(owner[key],undefined);
    assert.throws(()=>ownerDatabaseEnvironment({...prior,[key]:'unreviewed-value'}),/UNREVIEWED_AMBIENT_DATABASE_CONFIGURATION/);
  }
  const runtime=runtimeDatabaseEnvironment(prior,ownerUrl),url=new URL(runtime.DATABASE_URL),original=new URL(ownerUrl);
  assert.equal(url.username,RUNTIME_ROLE);assert.equal(url.password,encodeURIComponent(password));
  for(const key of ['sslmode','sslrootcert','application_name'])assert.equal(url.searchParams.get(key),original.searchParams.get(key));
  assert.equal(url.hostname,original.hostname);assert.equal(url.port,original.port);assert.equal(url.pathname,original.pathname);
  assert.equal(runtime.PACKPROOF_DB_USER,RUNTIME_ROLE);assert.equal(runtime.PACKPROOF_DB_PASSWORD,password);
  assert.equal(runtime.PACKPROOF_DB_SECRET_ARN,'');assert.equal(runtime.PACKPROOF_DB_CA_FILE,prior.PACKPROOF_DB_CA_FILE);
  assert.equal(runtime.PACKPROOF_REQUIRE_DURABLE_RECEIPTS,'true');assert.equal(runtime.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS,'false');
  assert.equal(Object.keys(runtime).some(key=>/^PACKPROOF_(ADMIN_|MIGRATION_|NEW_RUNTIME_)/.test(key)),false);
  assert.ok(!JSON.stringify(runtime).includes('OWNER_SECRET'));assert.ok(!JSON.stringify(runtime).includes('OWNER_CALLBACK_SECRET'));
  assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'OWNER_CALLBACK_SECRET');
  assert.throws(()=>ownerDatabaseEnvironment({NODE_TLS_REJECT_UNAUTHORIZED:'0'}),/VERIFIED_DATABASE_TLS_REQUIRED/);
});

test('alternate URL authority, session role overrides and malformed passwords fail without leaking values',()=>{
  for(const suffix of ['&user=someone','&password=DO_NOT_DISCLOSE','&host=another-db','&options=-c%20role%3Dpackproof','&options=-c%20search_path%3Devil',
    '&sslmode=disable','&options=-c%20lock_timeout%3D3s&options=-c%20role%3Dpackproof'])
    assert.throws(()=>runtimeDatabaseEnvironment(credentialEnv,ownerUrl+suffix),error=>!error.message.includes('DO_NOT_DISCLOSE')&&/UNREVIEWED_DATABASE/.test(error.message));
  for(const url of ['not-a-url-DO_NOT_DISCLOSE',ownerUrl.replace('packproof:','other:'),ownerUrl.replace(':OWNER_SECRET',''),ownerUrl+'#secret'])
    assert.throws(()=>runtimeDatabaseEnvironment(credentialEnv,url),error=>!error.message.includes('DO_NOT_DISCLOSE'));
  for(const candidate of [undefined,'short',' '.repeat(40),'ü'.repeat(40),'a'.repeat(257),'a'.repeat(31)+'\n'])
    assert.throws(()=>validateNewCredentials({...credentialEnv,PACKPROOF_NEW_RUNTIME_PASSWORD:candidate}),/INJECTED_RUNTIME_PASSWORD_REQUIRED/);
  assert.throws(()=>validateNewCredentials({...credentialEnv,PACKPROOF_NEW_RUNTIME_USERNAME:'packproof'}),/FIXED_RUNTIME_USERNAME_REQUIRED/);
  assert.equal(validateNewCredentials(credentialEnv),password);
});

test('database target requires the reviewed staging host, port and database before opening a connection',()=>{
  const pinned=`postgresql://${OWNER_ROLE}:EXPLICIT_OWNER_PASSWORD@${DATABASE_TARGET.host}:5432/${DATABASE_TARGET.database}?sslmode=verify-full`;
  assert.deepEqual(assertDatabaseTarget(pinned),DATABASE_TARGET);
  assert.deepEqual(assertDatabaseTarget(pinned.replace(':5432/','/')),DATABASE_TARGET);
  for(const different of [pinned.replace(DATABASE_TARGET.host,'another-db.example'),pinned.replace(':5432/',':5433/'),
    pinned.replace('/packproof_v2?','/other_database?'),pinned.replace(`${OWNER_ROLE}:`,`${RUNTIME_ROLE}:`)])
    assert.throws(()=>assertDatabaseTarget(different),/DATABASE_TARGET_MISMATCH|INJECTED_DATABASE_CREDENTIALS_REQUIRED/);
});

test('SCRAM verifier matches independently derived stored/server keys and never contains plaintext',()=>{
  const salt=Buffer.from('000102030405060708090a0b0c0d0e0f','hex');
  const salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const stored=hash(createHmac('sha256',salted).update('Client Key').digest());
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  const expected=`SCRAM-SHA-256$4096:${salt.toString('base64')}$${Buffer.from(stored,'hex').toString('base64')}:${server}`;
  assert.equal(scramVerifier(password,salt),expected);assert.ok(!expected.includes(password));
  assert.notEqual(scramVerifier(password),scramVerifier(password));
  assert.throws(()=>scramVerifier(password,Buffer.alloc(15)),/INVALID_SCRAM_SALT/);
});

test('full migration inventory matches independently pinned source and database receipts exactly',()=>{
  const receipts=inventory.map(({id,checksum})=>({id,checksum}));
  validateInventory([...inventory].reverse(),receipts,schemaHash);
  for(const malformed of [[],receipts.slice(1),[...receipts,receipts[0]],receipts.map((row,index)=>index===0?{...row,checksum:'0'.repeat(64)}:row),
    [...receipts,{id:'999_future',checksum:'f'.repeat(64)}]])assert.throws(()=>validateInventory(inventory,malformed,schemaHash),/INVALID_SCHEMA_INVENTORY|PINNED_SCHEMA_MISMATCH/);
  assert.throws(()=>validateInventory(inventory,receipts,'0'.repeat(64)),/PINNED_SCHEMA_MISMATCH/);
});

test('real schema role setup grants precisely bounded runtime and recovery authority',async()=>{
  const {pg,db}=await fixture();
  try{
    const before=await baseline(db);assert.ok(before.publicTables>100);
    const result=await applyRuntimeRoles(applyArgs(db));
    assert.equal(result.created,true);assert.deepEqual(result.authority.roles,[...GROUP_ROLES,RUNTIME_ROLE].sort());
    assert.deepEqual(result.authority.bindings.map(({parent})=>parent),[...APPLICATION_GROUPS].sort());
    for(const binding of result.authority.bindings)assert.deepEqual({admin:binding.admin_option,inherit:binding.inherit_option,set:binding.set_option},{admin:false,inherit:true,set:true});
    assert.ok(result.privileges.tableCount>100);assert.equal(result.privileges.ownerMembership,false);assert.equal(result.privileges.ownerSetRole,false);
    await pg.exec(`SET SESSION AUTHORIZATION ${RUNTIME_ROLE}`);
    const verified=await verifyRuntimePrivileges(db);assert.equal(verified.tableCount,before.publicTables);
    const probes=await probeDeniedAuthority(db);assert.equal(probes.deniedProbes.length,10);
    assert.equal((await db.query("SELECT current_user AS role,session_user AS login")).rows[0].role,RUNTIME_ROLE);
    assert.equal((await db.query("SELECT to_regclass('public.packproof_runtime_permission_probe') AS probe")).rows[0].probe,null);
    await pg.exec('RESET SESSION AUTHORIZATION');
    assert.deepEqual(await baseline(db),before);
    // An existing credential must authenticate before even beginning a mutation transaction.
    let checked=0,transactions=0;
    const intercepted={...db,transaction:work=>{transactions++;return db.transaction(work);}};
    await assert.rejects(applyRuntimeRoles({...applyArgs(intercepted),verifyExistingLogin:async()=>{checked++;throw Error('AUTHENTICATION_FAILED');}}),/AUTHENTICATION_FAILED/);
    assert.equal(checked,1);assert.equal(transactions,0);
    let authenticated=false;const queried=[];
    const tracked=client=>({query:(statement,params)=>{queried.push(statement);return client.query(statement,params);},transaction:work=>client.transaction(tx=>work(tracked(tx)))});
    const retried=await applyRuntimeRoles({...applyArgs(tracked(db)),verifyExistingLogin:async()=>{authenticated=true;}});
    assert.equal(authenticated,true);assert.equal(retried.created,false);assert.equal(queried.some(statement=>/ALTER\s+ROLE.*PASSWORD|CREATE\s+ROLE\s+"packproof_app_runtime_v1"/is.test(statement)),false);
  }finally{await pg.close();}
});

test('excess privileges and failed baseline guards roll back new roles and ACL changes together',async()=>{
  const {pg,db}=await fixture();
  try{
    const prior=(await db.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname='public'")).rows[0].acl;
    const excessive=sql+'\nGRANT TRUNCATE ON system_admin_audit_events TO packproof_runtime;';
    await assert.rejects(applyRuntimeRoles({...applyArgs(db),sql:excessive,expectedSqlHash:hash(excessive)}),/RUNTIME_TABLE_PRIVILEGE_MISMATCH/);
    assert.equal((await db.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[...GROUP_ROLES,RUNTIME_ROLE]])).rows.length,0);
    assert.equal((await db.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname='public'")).rows[0].acl,prior);
    await assert.rejects(applyRuntimeRoles({...applyArgs(db),verifyBaseline:async()=>{throw Error('BASELINE_CHANGED');}}),/BASELINE_CHANGED/);
    assert.equal((await db.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[RUNTIME_ROLE])).rows.length,0);
    let inspected=false;
    await assert.rejects(applyRuntimeRoles({...applyArgs({query:async()=>{inspected=true;throw Error('SHOULD_NOT_QUERY');}}),expectedSqlHash:'0'.repeat(64)}),/PINNED_RUNTIME_SQL_MISMATCH/);
    assert.equal(inspected,false);
  }finally{await pg.close();}
});

test('authority graph rejects unsafe role attributes, indirect owner paths, reverse grants, objects and session settings',async()=>{
  const {pg,db}=await fixture();
  try{
    await applyRuntimeRoles(applyArgs(db));
    const rejected=[
      [`ALTER ROLE ${RUNTIME_ROLE} CREATEROLE`,'UNSAFE_EXISTING_ROLE_ATTRIBUTES'],
      ['GRANT packproof TO packproof_runtime','UNSAFE_ROLE_MEMBERSHIP_GRAPH'],
      [`GRANT ${RUNTIME_ROLE} TO packproof`,'UNSAFE_ROLE_MEMBERSHIP_GRAPH'],
      [`ALTER ROLE ${RUNTIME_ROLE} SET search_path=public`,'UNSAFE_EXISTING_ROLE_ATTRIBUTES'],
      [`CREATE TABLE public.owned_probe(id integer); ALTER TABLE public.owned_probe OWNER TO ${RUNTIME_ROLE}`,'APPLICATION_ROLE_OWNS_DATABASE_OBJECTS'],
    ];
    for(const [statement,code] of rejected){
      await assert.rejects(db.transaction(async tx=>{for(const part of splitSqlStatements(statement))await tx.query(part);await inspectAuthority(tx,{requireRuntime:true});}),new RegExp(code));
      await inspectAuthority(db,{requireRuntime:true});
    }
    await assert.rejects(db.transaction(async tx=>{
      const database=(await tx.query('SELECT current_database() AS name')).rows[0].name;
      await tx.query(`ALTER ROLE ${RUNTIME_ROLE} IN DATABASE "${database.replaceAll('"','""')}" SET search_path=public`);
      await inspectAuthority(tx,{requireRuntime:true});
    }),/UNREVIEWED_ROLE_DATABASE_SETTINGS/);
    await assert.rejects(db.transaction(async tx=>{
      await tx.query("CREATE FUNCTION public.owner_escape_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
      await tx.query('ALTER FUNCTION public.owner_escape_probe() OWNER TO packproof');
      await inspectObjects(tx);
    }),/UNREVIEWED_FUNCTION_AUTHORITY/);
    for(const grant of [
      `GRANT INSERT(role) ON user_system_roles TO ${RUNTIME_ROLE}`,
      `GRANT UPDATE(reason) ON system_admin_audit_events TO ${RUNTIME_ROLE}`,
      `GRANT REFERENCES(user_id) ON user_system_roles TO ${RUNTIME_ROLE}`,
    ])await assert.rejects(db.transaction(async tx=>{await tx.query(grant);await verifyRuntimePrivileges(tx);}),/RUNTIME_COLUMN_PRIVILEGE_MISMATCH/);
    await assert.rejects(db.transaction(async tx=>{
      await tx.query('GRANT INSERT ON user_system_roles TO PUBLIC');await verifyRuntimePrivileges(tx);
    }),/RUNTIME_TABLE_PRIVILEGE_MISMATCH/);
  }finally{await pg.close();}
});

test('unrelated existing members of runtime groups prevent role setup before any privilege mutation',async()=>{
  const pg=new PGlite();await pg.waitReady;const db=wrap(pg);
  try{
    await pg.exec('CREATE ROLE packproof_runtime NOLOGIN; CREATE ROLE rogue_login LOGIN; GRANT packproof_runtime TO rogue_login');
    let baselineInvoked=false,statementsSplit=false;
    await assert.rejects(applyRuntimeRoles({...applyArgs(db),verifyBaseline:async()=>{baselineInvoked=true;},splitStatements:()=>{statementsSplit=true;return[];}}),/UNSAFE_ROLE_MEMBERSHIP_GRAPH/);
    assert.equal(baselineInvoked,false);assert.equal(statementsSplit,false);
    assert.equal((await db.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[RUNTIME_ROLE])).rows.length,0);
  }finally{await pg.close();}
});

test('negative capability probes roll back an unexpectedly allowed DDL operation before reporting failure',async()=>{
  const {pg,db}=await fixture();
  try{
    await applyRuntimeRoles(applyArgs(db));
    await pg.exec(`GRANT CREATE ON SCHEMA public TO ${RUNTIME_ROLE}; SET SESSION AUTHORIZATION ${RUNTIME_ROLE}`);
    await assert.rejects(probeDeniedAuthority(db),/NEGATIVE_PRIVILEGE_PROBE_FAILED_CREATE_TABLE/);
    assert.equal((await db.query("SELECT to_regclass('public.packproof_runtime_permission_probe') AS probe")).rows[0].probe,null);
    assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,RUNTIME_ROLE);
  }finally{await pg.close();}
});

test('ordinary CREATEROLE creator memberships fail closed and newly created login rolls back',async()=>{
  const pg=new PGlite();await pg.waitReady;const db=wrap(pg);
  try{
    await pg.exec(`CREATE ROLE ${OWNER_ROLE} LOGIN CREATEROLE; ${GROUP_ROLES.map(role=>`CREATE ROLE ${role} NOLOGIN`).join(';')}; SET SESSION AUTHORIZATION ${OWNER_ROLE};`);
    await assert.rejects(db.transaction(async tx=>{
      await tx.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await inspectAuthority(tx,{requireRuntime:true});
    }),/UNSAFE_ROLE_MEMBERSHIP_GRAPH/);
    assert.equal((await db.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[RUNTIME_ROLE])).rows.length,0);
    assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,OWNER_ROLE);
  }finally{await pg.close();}
});

test('expected privilege map preserves immutable records and recovery fencing boundaries',()=>{
  for(const table of ['schema_migrations','user_system_roles','recovery_writer_fence','policy_recovery_fence'])assert.deepEqual(expectedTablePrivileges(table),{SELECT:true,INSERT:false,UPDATE:false,DELETE:false,TRUNCATE:false,REFERENCES:false,TRIGGER:false});
  for(const table of ['system_admin_audit_events','admin_command_receipts','billing_allowance_adjustments'])assert.deepEqual(expectedTablePrivileges(table),{SELECT:true,INSERT:true,UPDATE:false,DELETE:false,TRUNCATE:false,REFERENCES:false,TRIGGER:false});
  assert.equal(expectedTablePrivileges('recovery_delivery').UPDATE,true);assert.equal(expectedTablePrivileges('recovery_delivery').DELETE,false);
  assert.equal(expectedTablePrivileges('client_version_activity').DELETE,false);assert.equal(expectedTablePrivileges('users').UPDATE,true);
});
