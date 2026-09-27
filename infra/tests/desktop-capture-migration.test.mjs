import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  MIGRATIONS,DATABASE_TARGET,assertDatabaseTarget,BASELINE_COUNT,BASELINE_INVENTORY_SHA256,EXPECTED_SOURCE_SHA,
  EXPECTED_DEFINITIONS,BASELINE_DEFINITIONS,readCaptureSchema,validateCaptureSchema,assertRetainedBaseline,readPrivilegeBoundary,digest,validateInspectionEvidence,
  inventoryDigest,validateInventory,ownerDatabaseEnvironment,temporaryDatabaseEnvironment,
  recoveryEvidence,withTemporaryAuthority,runNormalMigrator,
} from '../desktop-capture-migration.mjs';

const directory=new URL('../../backend/migrations/',import.meta.url);
const names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
const inventory=await Promise.all(names.map(async name=>{
  const sql=await readFile(new URL(name,directory),'utf8');
  return {id:name.slice(0,-4),checksum:createHash('sha256').update(sql).digest('hex'),sql};
}));
const receipt=row=>({id:row.id,checksum:row.checksum,checksum_provenance:'EXECUTED_BYTES'});
const baseline=inventory.filter(row=>!Object.hasOwn(MIGRATIONS,row.id)).map(receipt);
const complete=inventory.map(receipt);

test('only074 bytes and exact75 source inventory match the pinned candidate',async()=>{
  assert.equal(baseline.length,BASELINE_COUNT);assert.equal(inventory.length,75);
  assert.equal(inventoryDigest(baseline),BASELINE_INVENTORY_SHA256);
  assert.equal(EXPECTED_SOURCE_SHA,'d45727b8648ade030642a011c280c10bce525591');
  assert.deepEqual(Object.keys(MIGRATIONS),['074_desktop_capture_registration']);
  for(const [id,checksum]of Object.entries(MIGRATIONS))assert.equal(inventory.find(row=>row.id===id)?.checksum,checksum);
  const sql=inventory.find(row=>Object.hasOwn(MIGRATIONS,row.id)).sql;
  assert.doesNotMatch(sql,/CREATE TABLE|CREATE SEQUENCE|GRANT|SECURITY DEFINER/i);
});

test('admission allows only exact074, including every forward retry prefix',()=>{
  const additions=complete.filter(row=>Object.hasOwn(MIGRATIONS,row.id));
  for(let accepted=0;accepted<=1;accepted++)assert.deepEqual(
    validateInventory(inventory,[...baseline,...additions.slice(0,accepted)]),Object.keys(MIGRATIONS).slice(accepted),
  );
  assert.deepEqual(validateInventory([...inventory].reverse(),complete),[]);
  assert.throws(()=>validateInventory(inventory,baseline.slice(1)),/UNEXPECTED_PENDING/);
  assert.throws(()=>validateInventory(inventory,[...baseline,{id:'075_unreviewed',checksum:'a'.repeat(64)}]),/BASELINE_MISMATCH/);
  assert.throws(()=>validateInventory([...inventory,{id:'075_unreviewed',checksum:'a'.repeat(64)}],complete),/UNEXPECTED_SOURCE/);
  assert.throws(()=>validateInventory([...inventory,inventory[0]],baseline),/DUPLICATE/);
  assert.throws(()=>validateInventory(inventory,[...baseline,baseline[0]]),/DUPLICATE/);
});

test('changed historical or future bytes and unproven execution receipts fail closed',()=>{
  const firstNew=Object.keys(MIGRATIONS)[0];
  assert.throws(()=>validateInventory(inventory.map(row=>row.id===firstNew?{...row,checksum:'0'.repeat(64)}:row),baseline),/SOURCE_MISMATCH/);
  assert.throws(()=>validateInventory(inventory.map((row,i)=>i===0?{...row,checksum:'0'.repeat(64)}:row),baseline),/SOURCE_BASELINE/);
  assert.throws(()=>validateInventory(inventory,baseline.map((row,i)=>i===0?{...row,checksum:'0'.repeat(64)}:row)),/BASELINE_MISMATCH/);
  assert.throws(()=>validateInventory(inventory,baseline.map((row,i)=>i===0?{...row,checksum:null}:row)),/INVALID_MIGRATION/);
  assert.throws(()=>validateInventory(inventory,[...baseline,{id:firstNew,checksum:MIGRATIONS[firstNew],checksum_provenance:'REVIEWED_LEGACY_BASELINE_NOT_EXECUTION_PROOF'}]),/RECEIPT_MISMATCH/);
  // A different source baseline plus matching altered DB receipt is not admission.
  const substituted=inventory.map((row,i)=>i===0?{...row,checksum:'b'.repeat(64)}:row);
  assert.throws(()=>validateInventory(substituted,substituted.map(receipt)),/SOURCE_BASELINE/);
});

test('owner selection requires explicit authority, supports managed owner secret and never inherits runtime callback',()=>{
  const prior={DATABASE_URL:'postgresql://runtime:runtime-password@runtime/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret',PACKPROOF_DB_PASSWORD:'runtime-password',PGPASSWORD:'ambient-password',PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:'postgresql://packproof@db.example/packproof_v2?sslmode=verify-full',PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN:'explicit-owner-secret',PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'true'};
  const selected=ownerDatabaseEnvironment(prior);
  assert.equal(selected.DATABASE_URL,prior.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL);
  assert.equal(selected.PACKPROOF_DB_SECRET_ARN,'explicit-owner-secret');
  assert.equal(selected.PACKPROOF_DB_PASSWORD,undefined);assert.equal(selected.PGPASSWORD,undefined);
  assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'runtime-secret');
  assert.equal(selected.PACKPROOF_DB_CA_FILE,prior.PACKPROOF_DB_CA_FILE);assert.equal(selected.PACKPROOF_REQUIRE_DURABLE_RECEIPTS,'true');
  assert.throws(()=>ownerDatabaseEnvironment({DATABASE_URL:prior.DATABASE_URL,PACKPROOF_DB_SECRET_ARN:'runtime-secret'}),/SEPARATE_OPERATOR/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:'postgresql://packproof@db.example/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret'}),/EXPLICIT_OPERATOR/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:'postgresql://wrong:secret@db.example/db'}),/OWNER_MISMATCH/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:'secret-text-that-must-not-appear'}),error=>error.message==='INVALID_OPERATOR_DATABASE_URL');
  const direct=ownerDatabaseEnvironment({PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:'postgresql://packproof:explicit-password@db.example/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret'});
  assert.equal(direct.PACKPROOF_DB_SECRET_ARN,undefined);
});

test('connection query overrides are rejected and recovery target is pinned to the observed endpoint/database',()=>{
  const valid=`postgresql://packproof@${DATABASE_TARGET.host}:5432/${DATABASE_TARGET.database}?sslmode=verify-full`;
  assert.deepEqual(assertDatabaseTarget(valid),DATABASE_TARGET);
  for(const key of ['host','port','user','password','database','dbname','ssl'])assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:`${valid}&${key}=private-value`,PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN:'explicit-owner-secret'}),error=>error.message==='UNSUPPORTED_DATABASE_URL_PARAMETER');
  assert.throws(()=>assertDatabaseTarget(`${valid}&sslmode=require`),/UNSUPPORTED_DATABASE_URL_PARAMETER/);
  assert.throws(()=>assertDatabaseTarget(valid.replace(DATABASE_TARGET.host,'cloned.example')),/DATABASE_TARGET_MISMATCH/);
  assert.throws(()=>assertDatabaseTarget(valid.replace('5432','5433')),/DATABASE_TARGET_MISMATCH/);
  assert.throws(()=>assertDatabaseTarget(valid.replace('/packproof_v2','/other')),/DATABASE_TARGET_MISMATCH/);
});

test('temporary login retains TLS/durability, strips operator credentials and blocks dotenv resurrection',()=>{
  const source='postgresql://packproof:master-password@db.example:5432/packproof_v2?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Frds.pem&application_name=admin-migration';
  const prior={PACKPROOF_DB_SECRET_ARN:'owner-secret',PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL:source,PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN:'owner-secret',PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL:source,PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS:'true',PACKPROOF_DB_PASSWORD:'master-password',PGPASSWORD:'ambient-password',NODE_OPTIONS:'--require unexpected-loader',PACKPROOF_DB_CA_PEM:'public-CA-bytes',PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'false',PACKPROOF_MIGRATE_ON_START:'false'};
  const child=temporaryDatabaseEnvironment(prior,source,'pp_desktop_migrate_0123456789abcdef','1'.repeat(64));const url=new URL(child.DATABASE_URL),original=new URL(source);
  assert.equal(url.username,'pp_desktop_migrate_0123456789abcdef');assert.equal(url.password,'1'.repeat(64));assert.equal(child.PACKPROOF_MIGRATION_DATABASE_URL,child.DATABASE_URL);
  for(const key of ['sslmode','sslrootcert','application_name'])assert.equal(url.searchParams.get(key),original.searchParams.get(key));
  assert.equal(url.hostname,original.hostname);assert.equal(url.port,original.port);assert.equal(url.pathname,original.pathname);
  assert.match(url.searchParams.get('options'),/-c role=packproof/);assert.match(url.searchParams.get('options'),/statement_timeout=30000/);assert.match(url.searchParams.get('options'),/lock_timeout=15000/);
  assert.equal(child.PACKPROOF_DB_SECRET_ARN,'');assert.equal(child.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS,'false');assert.equal(child.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL,undefined);assert.equal(child.PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN,undefined);assert.equal(child.PGPASSWORD,undefined);assert.equal(child.NODE_OPTIONS,undefined);
  for(const key of ['PACKPROOF_DB_CA_FILE','PACKPROOF_DB_CA_PEM','PACKPROOF_REQUIRE_DURABLE_RECEIPTS','PACKPROOF_MIGRATE_ON_START'])assert.equal(child[key],prior[key]);
  assert.ok(!JSON.stringify(child).includes('master-password'));assert.ok(!JSON.stringify(child).includes('owner-secret'));assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'owner-secret');
  assert.throws(()=>temporaryDatabaseEnvironment({},source,'unbounded_role','1'.repeat(64)),/INVALID_TEMPORARY_LOGIN/);
  assert.throws(()=>temporaryDatabaseEnvironment({},source,'pp_desktop_migrate_0123456789abcdef','short'),/INVALID_TEMPORARY_PASSWORD/);
});

test('current recovery evidence is explicit and cannot claim stale or future observations',()=>{
  const env={PACKPROOF_DESKTOP_MIGRATION_RECOVERY_POINT:'2026-09-24T12:00:00Z',PACKPROOF_DESKTOP_MIGRATION_RECOVERY_DB_ID:'packproof-v2-staging-db'};
  assert.equal(recoveryEvidence(env,new Date('2026-09-24T12:10:00Z')).source,'OPERATOR_ATTESTED_RDS_OBSERVATION');
  assert.throws(()=>recoveryEvidence({},new Date()),/RECOVERY_EVIDENCE_REQUIRED/);
  assert.throws(()=>recoveryEvidence({...env,PACKPROOF_DESKTOP_MIGRATION_RECOVERY_DB_ID:'another-db'},new Date()),/RECOVERY_EVIDENCE_REQUIRED/);
  assert.throws(()=>recoveryEvidence(env,new Date('2026-09-24T14:00:00Z')),/STALE/);
  assert.throws(()=>recoveryEvidence(env,new Date('2026-09-24T11:00:00Z')),/STALE/);
});

test('temporary authority cleanup occurs after grant/run failures, never after failed creation',async()=>{
  for(const failure of [null,'create','grant','run','cleanup']){
    const calls=[];const step=name=>async()=>{calls.push(name);if(name===failure)throw Error(name);};
    const work=withTemporaryAuthority({create:step('create'),grant:step('grant'),run:step('run'),cleanup:step('cleanup')});
    if(failure)await assert.rejects(work);else await work;
    if(failure==='create')assert.deepEqual(calls,['create']);else{assert.equal(calls.at(-1),'cleanup');assert.equal(calls.filter(n=>n==='cleanup').length,1);}
  }
});

test('normal child never prints secrets and completion waits for close before cleanup',async()=>{
  const child=new EventEmitter();child.kill=()=>true;let options,command,args,cleaned=false;
  const work=withTemporaryAuthority({create:async()=>{},grant:async()=>{},run:()=>runNormalMigrator({DATABASE_URL:'private-credential-url'},new AbortController().signal,{spawnImpl:(c,a,o)=>{command=c;args=a;options=o;return child;},timeoutMs:1000}),cleanup:async()=>{cleaned=true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(command,process.execPath);assert.deepEqual(args,['dist/db/migrate-cli.js']);assert.equal(options.cwd,'/app');assert.equal(options.stdio,'ignore');assert.ok(!args.includes('private-credential-url'));
  child.emit('error',new Error('raw provider error with private credential'));await new Promise(resolve=>setImmediate(resolve));assert.equal(cleaned,false);
  child.emit('close',1);await assert.rejects(work,/CONTROLLED_MIGRATOR_FAILED/);assert.equal(cleaned,true);
});

test('aborted child is terminated and close is awaited; stuck child escalates to SIGKILL',async()=>{
  const controller=new AbortController(),child=new EventEmitter(),signals=[];child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('close',null));return true;};
  const work=runNormalMigrator({},controller.signal,{spawnImpl:()=>child,timeoutMs:1000,killAfterMs:5});controller.abort();await assert.rejects(work,/INTERRUPTED/);assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  let spawned=false;const already=new AbortController();already.abort();await assert.rejects(runNormalMigrator({},already.signal,{spawnImpl:()=>{spawned=true;return child;}}),/INTERRUPTED/);assert.equal(spawned,false);
});

test('apply requires the exact recent read-only inspection digest',()=>{
  const expected='a'.repeat(64),now=new Date('2026-09-27T12:30:00Z');
  const env={PACKPROOF_DESKTOP_MIGRATION_INSPECTION_SHA256:expected,PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT:'2026-09-27T12:25:00.000Z'};
  validateInspectionEvidence(env,expected,now);
  assert.throws(()=>validateInspectionEvidence({},expected,now),/PRIOR_READ_ONLY/);
  assert.throws(()=>validateInspectionEvidence({...env,PACKPROOF_DESKTOP_MIGRATION_INSPECTION_SHA256:'b'.repeat(64)},expected,now),/PRIOR_READ_ONLY/);
  assert.throws(()=>validateInspectionEvidence({...env,PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT:'2026-09-27T10:00:00Z'},expected,now),/STALE/);
  assert.throws(()=>validateInspectionEvidence({...env,PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT:'2026-09-28T12:25:00Z'},expected,now),/STALE/);
});

test('real PostgreSQL catalogs, existing grants and immutability match exact074 definitions',async()=>{
  const {PGlite}=await import('../../backend/node_modules/@electric-sql/pglite/dist/index.js');
  const db=new PGlite();
  try{
    await db.exec(`CREATE ROLE packproof; CREATE ROLE packproof_runtime; GRANT CREATE ON SCHEMA public TO packproof;
      SET ROLE packproof;
      CREATE TABLE capture_sessions(id text PRIMARY KEY,client text NOT NULL CONSTRAINT capture_sessions_client_check CHECK(client IN ('WEB_CAMERA','NATIVE_CAMERA')),identifier_policy jsonb,policy_version text,stage_id text,
      CONSTRAINT capture_identifier_policy_valid CHECK(identifier_policy IS NULL OR (identifier_policy->>'version'='1' AND identifier_policy->>'surface' IN ('ANDROID','IOS','WEB','WAREHOUSE'))));
      CREATE FUNCTION protect_existing_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE TRIGGER existing_capture_guard BEFORE UPDATE ON capture_sessions FOR EACH ROW EXECUTE FUNCTION protect_existing_capture();
      GRANT SELECT,INSERT,UPDATE,DELETE ON capture_sessions TO packproof_runtime;
      INSERT INTO capture_sessions(id,client,policy_version)VALUES('historic','WEB_CAMERA','historic-policy');`);
    const before=await readCaptureSchema(db),boundaryBefore=await readPrivilegeBoundary(db);
    validateCaptureSchema(before,false);
    const sql=inventory.find(row=>Object.hasOwn(MIGRATIONS,row.id)).sql;
    await db.exec(sql);
    const after=await readCaptureSchema(db),boundaryAfter=await readPrivilegeBoundary(db);
    validateCaptureSchema(after,true);assertRetainedBaseline(before,after);
    assert.equal(digest(boundaryAfter),digest(boundaryBefore));
    assert.deepEqual(after.runtimeColumnPrivileges,{can_select:true,can_insert:true,can_update:true});
    assert.deepEqual((await db.query("SELECT client,policy_version,desktop_context FROM capture_sessions WHERE id='historic'")).rows,[{client:'WEB_CAMERA',policy_version:'historic-policy',desktop_context:null}]);
    await db.query("INSERT INTO capture_sessions(id,client,policy_version,desktop_context)VALUES('desktop','DESKTOP_CAMERA','packproof.desktop-client-capture/v1',$1::jsonb)",[JSON.stringify({schemaVersion:1,platform:'win32'})]);
    await assert.rejects(db.query("UPDATE capture_sessions SET desktop_context=$1::jsonb WHERE id='desktop'",[JSON.stringify({schemaVersion:1,platform:'darwin'})]),/DESKTOP_CAPTURE_CONTEXT_IMMUTABLE/);
    await assert.rejects(db.query("INSERT INTO capture_sessions(id,client,policy_version,desktop_context)VALUES('invalid','DESKTOP_CAMERA','historic',$1::jsonb)",[JSON.stringify({schemaVersion:1,platform:'linux'})]),/desktop_capture_context_valid/);
    for(const mutation of [
      schema=>{schema.owner='packproof_runtime';},
      schema=>{schema.columns.find(row=>row.name==='desktop_context').type='text';},
      schema=>{schema.columns.find(row=>row.name==='desktop_context').acl='{packproof_runtime=r/packproof}';},
      schema=>{schema.constraints.find(row=>row.name==='desktop_capture_context_valid').definition='CHECK (true)';},
      schema=>{schema.constraints.find(row=>row.name==='desktop_capture_context_valid').validated=false;},
      schema=>{schema.triggers.find(row=>row.name==='desktop_capture_context_guard').enabled='D';},
      schema=>{schema.functions[0].security_definer=true;},
      schema=>{schema.functions[0].owner='packproof_runtime';},
      schema=>{schema.runtimeColumnPrivileges.can_insert=false;},
    ]){const changed=structuredClone(after);mutation(changed);assert.throws(()=>validateCaptureSchema(changed,true));}
    const changed=structuredClone(after);changed.triggers.find(row=>row.name==='existing_capture_guard').enabled='D';assert.throws(()=>assertRetainedBaseline(before,changed),/EXISTING_CAPTURE_PROTECTION_CHANGED/);
    assert.throws(()=>validateCaptureSchema(after,false),/CAPTURE_DEFINITION_MISMATCH|UNRECEIPTED_DESKTOP_SCHEMA/);
  }finally{await db.close();}
});

test('inspect exits before authority creation and no broad runtime-grant script can run',async()=>{
  const source=await readFile(new URL('../desktop-capture-migration.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf("if(mode==='--inspect')return;")<source.indexOf("phase='temporary_authority'"));
  assert.match(source,/SET TRANSACTION READ ONLY/);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm,''),/runtime-roles\.sql|GRANT.*packproof_runtime|ALTER ROLE|DROP OWNED|REASSIGN OWNED/);
});
