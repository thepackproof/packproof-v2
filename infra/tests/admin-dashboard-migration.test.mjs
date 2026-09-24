import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  MIGRATIONS,DATABASE_TARGET,assertDatabaseTarget,BASELINE_COUNT,BASELINE_INVENTORY_SHA256,NEW_TABLES,
  inventoryDigest,validateInventory,ownerDatabaseEnvironment,temporaryDatabaseEnvironment,
  recoveryEvidence,withTemporaryAuthority,runNormalMigrator,
} from '../admin-dashboard-migration.mjs';

const directory=new URL('../../backend/migrations/',import.meta.url);
const names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
const inventory=await Promise.all(names.map(async name=>{
  const sql=await readFile(new URL(name,directory),'utf8');
  return {id:name.slice(0,-4),checksum:createHash('sha256').update(sql).digest('hex'),sql};
}));
const receipt=row=>({id:row.id,checksum:row.checksum,checksum_provenance:'EXECUTED_BYTES'});
const baseline=inventory.filter(row=>!Object.hasOwn(MIGRATIONS,row.id)).map(receipt);
const complete=inventory.map(receipt);

test('all five reviewed hashes, complete historical inventory and eight table names match actual bytes',async()=>{
  assert.equal(baseline.length,BASELINE_COUNT);assert.equal(inventory.length,74);
  assert.equal(inventoryDigest(baseline),BASELINE_INVENTORY_SHA256);
  const runbook=await readFile(new URL('../../docs/ADMIN_DEPLOYMENT_RUNBOOK.md',import.meta.url),'utf8');
  for(const [id,checksum] of Object.entries(MIGRATIONS)){
    assert.equal(inventory.find(row=>row.id===id)?.checksum,checksum);
    assert.ok(runbook.includes(`\`${id}\` | \`${checksum}\``));
  }
  const tables=inventory.filter(row=>Object.hasOwn(MIGRATIONS,row.id)).flatMap(row=>[...row.sql.matchAll(/CREATE TABLE\s+([a-z_]+)/g)].map(match=>match[1])).sort();
  assert.deepEqual([...NEW_TABLES].sort(),tables);
});

test('admission allows only exact069–073, including every forward retry prefix',()=>{
  const additions=complete.filter(row=>Object.hasOwn(MIGRATIONS,row.id));
  for(let accepted=0;accepted<=5;accepted++)assert.deepEqual(
    validateInventory(inventory,[...baseline,...additions.slice(0,accepted)]),Object.keys(MIGRATIONS).slice(accepted),
  );
  assert.deepEqual(validateInventory([...inventory].reverse(),complete),[]);
  assert.throws(()=>validateInventory(inventory,baseline.slice(1)),/UNEXPECTED_PENDING/);
  assert.throws(()=>validateInventory(inventory,[...baseline,{id:'074_unreviewed',checksum:'a'.repeat(64)}]),/BASELINE_MISMATCH/);
  assert.throws(()=>validateInventory([...inventory,{id:'074_unreviewed',checksum:'a'.repeat(64)}],complete),/UNEXPECTED_SOURCE/);
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
  const prior={DATABASE_URL:'postgresql://runtime:runtime-password@runtime/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret',PACKPROOF_DB_PASSWORD:'runtime-password',PGPASSWORD:'ambient-password',PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:'postgresql://packproof@db.example/packproof_v2?sslmode=verify-full',PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN:'explicit-owner-secret',PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'true'};
  const selected=ownerDatabaseEnvironment(prior);
  assert.equal(selected.DATABASE_URL,prior.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL);
  assert.equal(selected.PACKPROOF_DB_SECRET_ARN,'explicit-owner-secret');
  assert.equal(selected.PACKPROOF_DB_PASSWORD,undefined);assert.equal(selected.PGPASSWORD,undefined);
  assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'runtime-secret');
  assert.equal(selected.PACKPROOF_DB_CA_FILE,prior.PACKPROOF_DB_CA_FILE);assert.equal(selected.PACKPROOF_REQUIRE_DURABLE_RECEIPTS,'true');
  assert.throws(()=>ownerDatabaseEnvironment({DATABASE_URL:prior.DATABASE_URL,PACKPROOF_DB_SECRET_ARN:'runtime-secret'}),/SEPARATE_OPERATOR/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:'postgresql://packproof@db.example/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret'}),/EXPLICIT_OPERATOR/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:'postgresql://wrong:secret@db.example/db'}),/OWNER_MISMATCH/);
  assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:'secret-text-that-must-not-appear'}),error=>error.message==='INVALID_OPERATOR_DATABASE_URL');
  const direct=ownerDatabaseEnvironment({PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:'postgresql://packproof:explicit-password@db.example/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret'});
  assert.equal(direct.PACKPROOF_DB_SECRET_ARN,undefined);
});

test('connection query overrides are rejected and recovery target is pinned to the observed endpoint/database',()=>{
  const valid=`postgresql://packproof@${DATABASE_TARGET.host}:5432/${DATABASE_TARGET.database}?sslmode=verify-full`;
  assert.deepEqual(assertDatabaseTarget(valid),DATABASE_TARGET);
  for(const key of ['host','port','user','password','database','dbname','ssl'])assert.throws(()=>ownerDatabaseEnvironment({PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:`${valid}&${key}=private-value`,PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN:'explicit-owner-secret'}),error=>error.message==='UNSUPPORTED_DATABASE_URL_PARAMETER');
  assert.throws(()=>assertDatabaseTarget(`${valid}&sslmode=require`),/UNSUPPORTED_DATABASE_URL_PARAMETER/);
  assert.throws(()=>assertDatabaseTarget(valid.replace(DATABASE_TARGET.host,'cloned.example')),/DATABASE_TARGET_MISMATCH/);
  assert.throws(()=>assertDatabaseTarget(valid.replace('5432','5433')),/DATABASE_TARGET_MISMATCH/);
  assert.throws(()=>assertDatabaseTarget(valid.replace('/packproof_v2','/other')),/DATABASE_TARGET_MISMATCH/);
});

test('temporary login retains TLS/durability, strips operator credentials and blocks dotenv resurrection',()=>{
  const source='postgresql://packproof:master-password@db.example:5432/packproof_v2?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Frds.pem&application_name=admin-migration';
  const prior={PACKPROOF_DB_SECRET_ARN:'owner-secret',PACKPROOF_ADMIN_MIGRATION_DATABASE_URL:source,PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN:'owner-secret',PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL:source,PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS:'true',PACKPROOF_DB_PASSWORD:'master-password',PGPASSWORD:'ambient-password',NODE_OPTIONS:'--require unexpected-loader',PACKPROOF_DB_CA_PEM:'public-CA-bytes',PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'false',PACKPROOF_MIGRATE_ON_START:'false'};
  const child=temporaryDatabaseEnvironment(prior,source,'pp_admin_migrate_0123456789abcdef','1'.repeat(64));const url=new URL(child.DATABASE_URL),original=new URL(source);
  assert.equal(url.username,'pp_admin_migrate_0123456789abcdef');assert.equal(url.password,'1'.repeat(64));assert.equal(child.PACKPROOF_MIGRATION_DATABASE_URL,child.DATABASE_URL);
  for(const key of ['sslmode','sslrootcert','application_name'])assert.equal(url.searchParams.get(key),original.searchParams.get(key));
  assert.equal(url.hostname,original.hostname);assert.equal(url.port,original.port);assert.equal(url.pathname,original.pathname);
  assert.match(url.searchParams.get('options'),/-c role=packproof/);assert.match(url.searchParams.get('options'),/statement_timeout=30000/);assert.match(url.searchParams.get('options'),/lock_timeout=15000/);
  assert.equal(child.PACKPROOF_DB_SECRET_ARN,'');assert.equal(child.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS,'false');assert.equal(child.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL,undefined);assert.equal(child.PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN,undefined);assert.equal(child.PGPASSWORD,undefined);assert.equal(child.NODE_OPTIONS,undefined);
  for(const key of ['PACKPROOF_DB_CA_FILE','PACKPROOF_DB_CA_PEM','PACKPROOF_REQUIRE_DURABLE_RECEIPTS','PACKPROOF_MIGRATE_ON_START'])assert.equal(child[key],prior[key]);
  assert.ok(!JSON.stringify(child).includes('master-password'));assert.ok(!JSON.stringify(child).includes('owner-secret'));assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'owner-secret');
  assert.throws(()=>temporaryDatabaseEnvironment({},source,'unbounded_role','1'.repeat(64)),/INVALID_TEMPORARY_LOGIN/);
  assert.throws(()=>temporaryDatabaseEnvironment({},source,'pp_admin_migrate_0123456789abcdef','short'),/INVALID_TEMPORARY_PASSWORD/);
});

test('current recovery evidence is explicit and cannot claim stale or future observations',()=>{
  const env={PACKPROOF_ADMIN_MIGRATION_RECOVERY_POINT:'2026-09-24T12:00:00Z',PACKPROOF_ADMIN_MIGRATION_RECOVERY_DB_ID:'packproof-v2-staging-db'};
  assert.equal(recoveryEvidence(env,new Date('2026-09-24T12:10:00Z')).source,'OPERATOR_ATTESTED_RDS_OBSERVATION');
  assert.throws(()=>recoveryEvidence({},new Date()),/RECOVERY_EVIDENCE_REQUIRED/);
  assert.throws(()=>recoveryEvidence({...env,PACKPROOF_ADMIN_MIGRATION_RECOVERY_DB_ID:'another-db'},new Date()),/RECOVERY_EVIDENCE_REQUIRED/);
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
