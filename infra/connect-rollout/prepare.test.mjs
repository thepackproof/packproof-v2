import assert from 'node:assert/strict';
import test from 'node:test';
import {packetProfile,recoveryPacketInput} from './prepare.mjs';

test('the130 release packet selects its separate archive profile and leaves the124 packet frozen',()=>{
  assert.equal(packetProfile('130_connect_recovery_collector_version.sql'),'recovery-v1');
  assert.equal(packetProfile('124_connect_collector_version.sql'),'reconstruction-v11');
  for(const name of ['129_unified_collector_version.sql','130_unreviewed.sql','131_unreviewed.sql',''])
    assert.throws(()=>packetProfile(name),/reviewed release packet profile/);
});

test('recovery packet inputs bind exact source and catalogue without fabricating predecessor/build/deployment evidence',()=>{
  const source='a'.repeat(40),exact={sourceSha:source,allGitBlobBytesVerified:true,migrationCount:129,
    migrationInventorySha256:'13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e',archiveSha256:'b'.repeat(64)};
  const input=recoveryPacketInput(source,exact);
  assert.equal(input.archiveProfile,'recovery-v1');assert.equal(input.firstPhase,'inspect');
  assert.equal(input.requiresObservedPredecessor,true);assert.equal(input.requiresVersionedArchive,true);
  assert.equal(input.requiresSuccessfulMainCI,true);assert.equal(input.imagesBuilt,false);assert.equal(input.productionQualified,false);
  assert.doesNotMatch(JSON.stringify(input),/3722c462|collector-hosted-bridge|connect-runtime-|approvedPredecessorImage|sourceVersion/);
  for(const changed of [{sourceSha:'c'.repeat(40)},{allGitBlobBytesVerified:false},{migrationCount:128},
    {migrationInventorySha256:'f'.repeat(64)},{archiveSha256:'latest'}])
    assert.throws(()=>recoveryPacketInput(source,{...exact,...changed}),/exact verified source/);
});
