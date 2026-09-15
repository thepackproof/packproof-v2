import test from 'node:test';
import assert from 'node:assert/strict';
import {MIGRATIONS,validateInventory,temporaryDatabaseEnvironment,withTemporaryAuthority} from '../mobile-intake-migration.mjs';

const base={id:'066_ios_capture_surfaces',checksum:'baseline'};
const inventory=[base,...Object.entries(MIGRATIONS).map(([id,checksum])=>({id,checksum}))];
test('migration admission permits only exact additive067/068 and safe partial retry',()=>{
  assert.deepEqual(validateInventory(inventory,[base]),Object.keys(MIGRATIONS));
  assert.deepEqual(validateInventory(inventory,inventory.slice(0,2)),['068_commerce_sync_checkpoints']);
  assert.deepEqual(validateInventory(inventory,inventory),[]);
  assert.throws(()=>validateInventory(inventory,[]),/UNEXPECTED_PENDING/);
  assert.throws(()=>validateInventory(inventory,[{...base,checksum:'wrong'}]),/BASELINE_MISMATCH/);
  assert.throws(()=>validateInventory(inventory,[base,{id:'069_unknown',checksum:'unknown'}]),/BASELINE_MISMATCH/);
  assert.throws(()=>validateInventory(inventory.map(row=>row.id.startsWith('067')?{...row,checksum:'changed'}:row),[base]),/SOURCE_MISMATCH/);
  assert.throws(()=>validateInventory([...inventory,base],[base]),/DUPLICATE/);
});
test('temporary environment preserves TLS/durability but removes master-password callback and checksum adoption',()=>{
  const prior={PACKPROOF_DB_SECRET_ARN:'existing-master-reference',PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS:'true',PACKPROOF_DB_CA_FILE:'/app/certs/rds.pem',PACKPROOF_REQUIRE_DURABLE_RECEIPTS:'false'};
  const env=temporaryDatabaseEnvironment(prior,'postgresql://packproof:old@db.example/packproof_v2','pp_intake_migrate_0123456789abcdef','new-pass');
  const url=new URL(env.DATABASE_URL);
  assert.equal(url.username,'pp_intake_migrate_0123456789abcdef');assert.equal(url.password,'new-pass');
  assert.equal(env.PACKPROOF_MIGRATION_ROLE,'packproof');assert.match(url.searchParams.get('options'),/role=packproof/);
  assert.match(url.searchParams.get('options'),/statement_timeout=30000/);assert.match(url.searchParams.get('options'),/lock_timeout=15000/);
  assert.equal(env.PACKPROOF_DB_SECRET_ARN,undefined);assert.equal(env.PACKPROOF_ADOPT_LEGACY_MIGRATION_CHECKSUMS,undefined);
  assert.equal(env.PACKPROOF_DB_CA_FILE,prior.PACKPROOF_DB_CA_FILE);assert.equal(env.PACKPROOF_REQUIRE_DURABLE_RECEIPTS,'false');
  assert.equal(prior.PACKPROOF_DB_SECRET_ARN,'existing-master-reference');
  assert.throws(()=>temporaryDatabaseEnvironment({},'postgresql://other@db.example/db','pp_intake_migrate_0123456789abcdef','p'),/OWNER_MISMATCH/);
  assert.throws(()=>temporaryDatabaseEnvironment({},'postgresql://packproof@db.example/db','arbitrary_role','p'),/INVALID_TEMPORARY_LOGIN/);
});
test('temporary authority is cleaned after success, grant failure and migration failure',async()=>{
  for(const failing of [null,'grant','run']){
    const calls=[];const step=name=>async()=>{calls.push(name);if(failing===name)throw new Error(name);};
    const work=withTemporaryAuthority({create:step('create'),grant:step('grant'),run:step('run'),cleanup:step('cleanup')});
    if(failing)await assert.rejects(work);else await work;
    assert.equal(calls.at(-1),'cleanup');assert.equal(calls.filter(c=>c==='cleanup').length,1);
  }
});
test('a failed creation never drops an uncreated role and cleanup failure fails the operation',async()=>{
  let cleanup=0;
  await assert.rejects(withTemporaryAuthority({create:async()=>{throw Error('creation');},grant:async()=>{},run:async()=>{},cleanup:async()=>cleanup++}));
  assert.equal(cleanup,0);
  await assert.rejects(withTemporaryAuthority({create:async()=>{},grant:async()=>{},run:async()=>{},cleanup:async()=>{throw Error('cleanup');}}),/cleanup/);
});
