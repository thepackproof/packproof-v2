import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareRecoveryImages } from './recovery-image-builds.mjs';
import { readInventory, buildGuard, inventorySha256 } from '../../backend/scripts/recovery-forward-guard.mjs';

test('the generated previous reader preserves old decisions and admits only the exact one receipt',async()=>{
  const rows=readInventory(fileURLToPath(new URL('../../backend/migrations',import.meta.url)));
  const root=mkdtempSync(join(tmpdir(),'recovery-guard-'));
  try {
    writeFileSync(join(root,'package.json'),'{"type":"module"}');
    writeFileSync(join(root,'forward-compatible-migrations.recovery129.js'),
      "export const FORWARD_COMPATIBLE_MIGRATIONS=[{id:'prior',checksum:'trusted'}]; export const isReviewedForwardCompatibleMigration=r=>r?.id==='prior'&&r.checksum==='trusted';");
    const before=rows.slice(0,128);
    writeFileSync(join(root,'guard.mjs'),buildGuard(before,rows));
    const guard=await import(pathToFileURL(join(root,'guard.mjs')));
    assert.equal(guard.isReviewedForwardCompatibleMigration({id:'prior',checksum:'trusted'}),true);
    for(const row of rows.slice(128)){
      assert.equal(guard.isReviewedForwardCompatibleMigration(row),true);
      assert.equal(guard.isReviewedForwardCompatibleMigration({...row,checksum:'0'.repeat(64)}),false);
    }
    assert.equal(guard.isReviewedForwardCompatibleMigration({id:'131_unreviewed',checksum:rows[128].checksum}),false);
    assert.throws(()=>buildGuard(before,rows.slice(0,128)));
    assert.throws(()=>buildGuard(before.slice(1),rows));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('the image request binds source version, predecessor and both tags',()=>{
  const input={source:'a'.repeat(40),archiveSha256:'b'.repeat(64),sourceVersion:'version-123',
    predecessorImage:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:'+'c'.repeat(64)};
  const {request,receipt}=prepareRecoveryImages(input);
  assert.equal(request.sourceVersion,input.sourceVersion);
  assert.ok(request.sourceLocationOverride.includes(input.archiveSha256));
  assert.equal(receipt.inventorySha256,inventorySha256);
  assert.equal(receipt.fallbackTag,'recovery-compat-'+input.source);
  for (const bad of [{predecessorImage:input.predecessorImage.replace('784514617543','000000000000')},
      {predecessorImage:input.predecessorImage.split('@')[0]+':latest'}, {sourceVersion:'null'}, {archiveSha256:'unverified'}])
    assert.throws(()=>prepareRecoveryImages({...input,...bad}));
  assert.ok(!request.buildspecOverride.includes('ecs update'));
  assert.match(request.buildspecOverride,/verify-recovery-images/);
});
