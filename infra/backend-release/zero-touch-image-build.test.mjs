import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {ZERO_TOUCH_IMAGE_SOURCE as sourceSha,ZERO_TOUCH_ARCHIVE_SHA256 as zipSha256,zeroTouchImageBuildRequest} from './zero-touch-image-build.mjs';

test('image request pins exact tested main Git archive and any available S3 version',()=>{
 const r=zeroTouchImageBuildRequest({sourceSha,zipSha256,sourceVersion:'verified-version'});
 assert.equal(r.sourceVersion,'verified-version');
 assert.equal(r.sourceLocationOverride,`packproof-v2-staging-build-784514617543/security-release/${sourceSha}/${zipSha256}/backend.zip`);
 assert.equal(r.environmentVariablesOverride.find(v=>v.name==='IMAGE_TAG').value,`zero-touch-v1-${sourceSha}`);
 assert.equal(r.timeoutInMinutesOverride,30);
 const commands=JSON.stringify(JSON.parse(r.buildspecOverride));
 assert.match(commands,/inspectSourceAssociationInventory/);
 assert.match(commands,/rows.length!==108/);
 assert.match(commands,/databaseQualification:false/);
 assert.match(commands,/ZERO_TOUCH_BASE_RETENTION_REQUIRED/);
 assert.ok(commands.includes(zipSha256));
 assert.match(commands,/sha256sum --check/);
 assert.match(commands,/cd \/tmp\/zero-touch-reviewed/);
 assert.doesNotMatch(commands,/update-service|run-task|migrate-cli|records-migrate|latest/);
 execFileSync('sh',['-n'],{input:Object.values(JSON.parse(r.buildspecOverride).phases).flatMap(p=>p.commands).join('\n')+'\n'});
});
test('a changed source/archive or invalid version cannot launch this reviewed build',()=>{
 for(const input of [{sourceSha:'a'.repeat(40),zipSha256,sourceVersion:'v'},{sourceSha,zipSha256:'b'.repeat(64),sourceVersion:'v'},{sourceSha,zipSha256,sourceVersion:''},{sourceSha,zipSha256,sourceVersion:'null'}])assert.throws(()=>zeroTouchImageBuildRequest(input),/ZERO_TOUCH_EXACT_REVIEWED_ARCHIVE_REQUIRED/);
 const unversioned=zeroTouchImageBuildRequest({sourceSha,zipSha256});
 assert.equal(unversioned.sourceVersion,undefined);
 assert.match(unversioned.buildspecOverride,/reviewed-source.zip/);
});
