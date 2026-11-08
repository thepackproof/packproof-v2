import test from 'node:test';
import assert from 'node:assert/strict';
import {zeroTouchSecurityBuildRequest,SECURITY_BASES} from './zero-touch-security-images.mjs';
import {ZERO_TOUCH_IMAGE_SOURCE,ZERO_TOUCH_ARCHIVE_SHA256} from './zero-touch-image-build.mjs';
const input={sourceSha:ZERO_TOUCH_IMAGE_SOURCE,zipSha256:ZERO_TOUCH_ARCHIVE_SHA256};
test('both security images pin their parent and preserve application/migration/package bytes',()=>{
 for(const profile of Object.keys(SECURITY_BASES)){
  const r=zeroTouchSecurityBuildRequest(profile,input),spec=JSON.parse(r.buildspecOverride),commands=spec.phases.build.commands.join('\n');
  assert.match(commands,/zlib>=1\.4-r0/);
  assert.match(commands,/find dist migrations scripts node_modules/);
  assert.match(commands,/cmp \/tmp\/zero-touch-before.sha256 \/tmp\/zero-touch-after.sha256/);
  assert.match(commands,/USER node/);
  assert.ok(commands.includes(SECURITY_BASES[profile]));
  assert.doesNotMatch(commands,/npm (ci|install)|migrate-cli|update-service|CREATE ROLE/);
  assert.equal(r.environmentVariablesOverride.find(x=>x.name==='IMAGE_TAG').value,`zero-touch-${profile}-zlib14-${ZERO_TOUCH_IMAGE_SOURCE}`);
  assert.ok(r.idempotencyToken.length<=64);
 }
});
test('unknown image or source cannot prepare a security build',()=>{
 assert.throws(()=>zeroTouchSecurityBuildRequest('latest',input),/SECURITY_PROFILE/);
 assert.throws(()=>zeroTouchSecurityBuildRequest('candidate',{...input,sourceSha:'a'.repeat(40)}),/EXACT_REVIEWED_ARCHIVE/);
});
