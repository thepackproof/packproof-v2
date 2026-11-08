import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ROLLBACK_ADDITIONS,extendRollbackGuard,zeroTouchRollbackBuildRequest} from './zero-touch-rollback-image.mjs';
import {ZERO_TOUCH_IMAGE_SOURCE,ZERO_TOUCH_ARCHIVE_SHA256} from './zero-touch-image-build.mjs';
const input={sourceSha:ZERO_TOUCH_IMAGE_SOURCE,zipSha256:ZERO_TOUCH_ARCHIVE_SHA256};
test('bridge changes only exact future receipt admission and preserves earlier rules',async()=>{
 const original=(await readFile(new URL('../../backend/src/db/forward-compatible-migrations.ts',import.meta.url),'utf8')).replace('row: {id: string; checksum: string | null}): boolean','row)');
 const load=text=>import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
 const before=await load(original),after=await load(extendRollbackGuard(original));
 assert.deepEqual(after.FORWARD_COMPATIBLE_MIGRATIONS.slice(2),before.FORWARD_COMPATIBLE_MIGRATIONS);
 for(const pin of ROLLBACK_ADDITIONS){
  assert.equal(before.isReviewedForwardCompatibleMigration(pin),false);
  assert.equal(after.isReviewedForwardCompatibleMigration(pin),true);
  for(const invalid of [{...pin,checksum:null},{...pin,checksum:'0'.repeat(64)},{...pin,id:'110_unreviewed'}])assert.equal(after.isReviewedForwardCompatibleMigration(invalid),false);
 }
 assert.throws(()=>extendRollbackGuard(extendRollbackGuard(original)),/UNMODIFIED_BASE/);
});
test('build retains the immutable deployed layers and106 source inventory',()=>{
 const r=zeroTouchRollbackBuildRequest(input),s=JSON.parse(r.buildspecOverride),commands=s.phases.build.commands.join('\n');
 assert.equal(r.environmentVariablesOverride.find(x=>x.name==='IMAGE_TAG').value,`zero-touch-rollback-v1-${ZERO_TOUCH_IMAGE_SOURCE}`);
 assert.ok(s.phases.pre_build.commands.some(x=>x.includes(`test "$IMAGE_TAG" = 'zero-touch-rollback-v1-${ZERO_TOUCH_IMAGE_SOURCE}'`)));
 assert.match(commands,/rows.length!==106/);
 assert.match(commands,/base.RootFS.Layers.length\+1/);
 assert.match(commands,/COPY guard.js \/app\/backend\/dist\/db\/forward-compatible-migrations.js/);
 assert.doesNotMatch(commands,/npm |migrate-cli|update-service|CREATE ROLE/);
 assert.match(s.phases.pre_build.commands.join('\n'),/sha256sum --check/);
 assert.equal(r.sourceVersion,undefined);
});
test('wrong source or archive cannot prepare rollback build',()=>{
 assert.throws(()=>zeroTouchRollbackBuildRequest({...input,sourceSha:'a'.repeat(40)}),/EXACT_REVIEWED_ARCHIVE/);
 assert.throws(()=>zeroTouchRollbackBuildRequest({...input,zipSha256:'b'.repeat(64)}),/EXACT_REVIEWED_ARCHIVE/);
 assert.throws(()=>extendRollbackGuard('export const anything=[];'),/UNMODIFIED_BASE/);
});
