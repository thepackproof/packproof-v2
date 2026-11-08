import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONNECT_IMAGE_BASE,CONNECT_IMAGE_INVENTORY,CONNECT_ROLLBACK_DOCKERFILE,connectBuildspec,connectImageBuildRequest} from './connect-image-builds.mjs';
const sourceSha='a'.repeat(40),zipSha256='b'.repeat(64);
test('Connect build pins reviewed full-source archive and creates only a StartBuild request',()=>{
 const request=connectImageBuildRequest({profile:'candidate',sourceSha,zipSha256,sourceVersion:'version-123'});
 assert.equal(request.projectName,'packproof-v2-staging-api');
 assert.equal(request.sourceTypeOverride,'S3');
 assert.equal(request.sourceLocationOverride,`packproof-v2-staging-build-784514617543/security-release/${sourceSha}/${zipSha256}/backend.zip`);
 assert.equal(request.sourceVersion,'version-123');
 assert.deepEqual(request.environmentVariablesOverride,[{name:'REVIEWED_SOURCE_SHA',value:sourceSha,type:'PLAINTEXT'},{name:'IMAGE_TAG',value:`connect-v1-${sourceSha}`,type:'PLAINTEXT'}]);
 const build=JSON.parse(request.buildspecOverride);
 assert.ok(build.phases.build.commands.some(command=>command.includes('inspectAgentMigrationInventory')));
 assert.ok(build.phases.build.commands.some(command=>command.includes('databaseQualification:false')));
 assert.ok(!JSON.stringify(request).includes('latest'));
 assert.ok(!JSON.stringify(request).includes('update-service'));
 assert.ok(build.phases.pre_build.commands.some(command=>command.includes('CONNECT_IMAGE_TAG_ALREADY_EXISTS')&&command.includes('CONNECT_BASE_RETENTION_REVIEW_REQUIRED')));
});
test('rollback preserves actual immutable base and copies only the exact compiled guard',()=>{
 assert.equal(CONNECT_ROLLBACK_DOCKERFILE.split(`FROM ${CONNECT_IMAGE_BASE.image}`).length,3);
 const releasedStage=CONNECT_ROLLBACK_DOCKERFILE.split(`FROM ${CONNECT_IMAGE_BASE.image}\n`)[1];
 assert.equal(releasedStage,'COPY --from=guard-build /app/backend/dist/db/forward-compatible-migrations.js /app/backend/dist/db/forward-compatible-migrations.js\nUSER node\n');
 const request=connectImageBuildRequest({profile:'rollback',sourceSha,zipSha256});
 assert.equal(request.environmentVariablesOverride[1].value,`connect-rollback-${sourceSha}`);
 const build=JSON.parse(request.buildspecOverride),commands=build.phases.build.commands.join('\n');
 const preparation=build.phases.pre_build.commands;
 const pull=preparation.indexOf(`docker pull '${CONNECT_IMAGE_BASE.image}'`);
 const login=preparation.findIndex(command=>command.includes('docker login'));
 assert.ok(login>=0&&pull>login);
 assert.equal(preparation.filter(command=>command.startsWith('docker pull ')).length,1);
 assert.match(commands,/rows.length!==106/);
 assert.match(commands,/checksum:null/);
 assert.match(commands,/109_unreviewed/);
 assert.match(commands,/CONNECT_ROLLBACK_IMMUTABLE_BASE_REQUIRED/);
 assert.doesNotMatch(commands,/migrate-cli|records-migrate/);
});
test('invalid profile/source pins cannot create a build request',()=>{
 assert.throws(()=>connectBuildspec('production'),/CONNECT_IMAGE_PROFILE_REQUIRED/);
 assert.throws(()=>connectImageBuildRequest({profile:'candidate',sourceSha:'main',zipSha256}),/INVALID_BUILD_PINS/);
 assert.throws(()=>connectImageBuildRequest({profile:'rollback',sourceSha,zipSha256:'latest'}),/INVALID_BUILD_PINS/);
 assert.throws(()=>connectImageBuildRequest({profile:'candidate',sourceSha,zipSha256,sourceVersion:'null'}),/INVALID_S3_VERSION/);
});
test('exact current Git archive supplies Docker inputs while rejecting the frozen Connect108 profile',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const directory=mkdtempSync(path.join(tmpdir(),'connect-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py');
  const run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'zero-touch-v1',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);
  assert.deepEqual(verified,created);
  assert.equal(verified.allGitBlobBytesVerified,true);
  const current=JSON.parse(readFileSync(new URL('../../backend/scripts/source-association-migration-manifest.json',import.meta.url),'utf8'));
  assert.equal(verified.migrationCount,108);
  assert.equal(verified.migrationInventorySha256,current.inventorySha256);
  assert.equal(CONNECT_IMAGE_INVENTORY.count,107);
  assert.equal(CONNECT_IMAGE_INVENTORY.sha256,'ac0f0b11921f57e6dffeba0561c3e8e0991e63f9b6eaa1870ce5c7246d5a5921');
  assert.throws(()=>execFileSync('python',[script,head,path.join(directory,'wrong-profile.zip'),'connect-v1'],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'}));
  const dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from='))){
   for(const input of line.trim().split(/\s+/).slice(1,-1))
    assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  }
  assert.deepEqual(names.filter(name=>name.startsWith('infra/')).sort(),['infra/backend-release/record-agent-database-preflight.mjs','infra/backend-release/record-agent-previous-image-probe.mjs']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
