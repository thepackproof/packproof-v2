import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
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
test('exact reconstruction113 Git archive supplies Docker inputs while frozen108 and109 profiles reject it',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const head='bd63a7cb591cdf217e9c978e71bb3494c323223c';
 const directory=mkdtempSync(path.join(tmpdir(),'connect-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py');
  const run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v1',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);
  assert.deepEqual(verified,created);
  assert.equal(verified.allGitBlobBytesVerified,true);
  const current=JSON.parse(readFileSync(new URL('../../backend/scripts/source-association-migration-manifest.json',import.meta.url),'utf8'));
  assert.equal(verified.migrationCount,112);
  assert.notEqual(verified.migrationInventorySha256,current.inventorySha256);
  assert.match(verified.migrationInventorySha256,/^[a-f0-9]{64}$/);
  assert.equal(CONNECT_IMAGE_INVENTORY.count,107);
  assert.equal(CONNECT_IMAGE_INVENTORY.sha256,'ac0f0b11921f57e6dffeba0561c3e8e0991e63f9b6eaa1870ce5c7246d5a5921');
  assert.throws(()=>execFileSync('python',[script,head,path.join(directory,'wrong-profile.zip'),'connect-v1'],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  assert.throws(()=>execFileSync('python',[script,head,path.join(directory,'wrong109-profile.zip'),'zero-touch-v1'],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'}));
  const dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from='))){
   for(const input of line.trim().split(/\s+/).slice(1,-1))
    assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  }
  assert.deepEqual(names.filter(name=>name.startsWith('infra/')).sort(),['infra/backend-release/reconstruction-release-review.mjs','infra/backend-release/reconstruction-runtime-preflight.mjs','infra/backend-release/record-agent-database-preflight.mjs','infra/backend-release/record-agent-previous-image-probe.mjs']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('exact reconstruction116 Git archive supplies all v2 Docker inputs while frozen profiles reject it',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),head='c2eef10b73079f00fdeb9dde94310bbef67a1155';
 const directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v2-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py');
  const run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v2',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);assert.deepEqual(verified,created);assert.equal(verified.migrationCount,115);assert.equal(verified.allGitBlobBytesVerified,true);
  for(const profile of ['connect-v1','zero-touch-v1','reconstruction-v1'])assert.throws(()=>execFileSync('python',[script,head,path.join(directory,profile+'.zip'),profile],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'}));
  const dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from=')))for(const input of line.trim().split(/\s+/).slice(1,-1))assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  for(const name of ['reconstruction-v2-release-review.mjs','reconstruction-v2-runtime-preflight.mjs'])assert.ok(names.includes('infra/backend-release/'+name));
  assert.throws(()=>execFileSync('python',[script,'bd63a7cb591cdf217e9c978e71bb3494c323223c',path.join(directory,'predecessor.zip'),'reconstruction-v2'],{cwd:root,encoding:'utf8',stdio:'pipe'}),/CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

const backfillRoot=fileURLToPath(new URL('../../',import.meta.url));
let committedBackfill=false;
try{execFileSync('git',['cat-file','-e','HEAD:backend/migrations/117_source_backfill_jobs.sql'],{cwd:backfillRoot,stdio:'ignore'});committedBackfill=true;}catch{}
let committedRechecks=false;
try{execFileSync('git',['cat-file','-e','HEAD:backend/migrations/118_source_projection_rechecks.sql'],{cwd:backfillRoot,stdio:'ignore'});committedRechecks=true;committedBackfill=false;}catch{}
test('reconstruction117 archive refuses the qualified116 source instead of silently widening its profile',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v3-predecessor-'));
 try{assert.throws(()=>execFileSync('python',[path.join(backfillRoot,'infra/backend-release/backend-source-archive.py'),'c2eef10b73079f00fdeb9dde94310bbef67a1155',path.join(directory,'source.zip'),'reconstruction-v3'],{cwd:backfillRoot,encoding:'utf8',stdio:'pipe'}),/CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('exact committed117 Git archive supplies all v3 Docker inputs while frozen116 rejects it',{skip:!committedBackfill&&'Requires an exact117 source; a later118 source belongs to the separate v4 profile'},()=>{
 const root=backfillRoot,head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v3-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py'),run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v3',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);assert.deepEqual(verified,created);assert.equal(verified.migrationCount,116);assert.equal(verified.allGitBlobBytesVerified,true);
  for(const profile of ['connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2'])assert.throws(()=>execFileSync('python',[script,head,path.join(directory,profile+'.zip'),profile],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'})),dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from=')))for(const input of line.trim().split(/\s+/).slice(1,-1))assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  for(const name of ['reconstruction-v3-release-review.mjs','reconstruction-v3-runtime-preflight.mjs'])assert.ok(names.includes('infra/backend-release/'+name));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('reconstruction118 archive refuses the qualified116 source instead of widening a prior profile',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v4-predecessor-'));
 try{assert.throws(()=>execFileSync('python',[path.join(backfillRoot,'infra/backend-release/backend-source-archive.py'),'c2eef10b73079f00fdeb9dde94310bbef67a1155',path.join(directory,'source.zip'),'reconstruction-v4'],{cwd:backfillRoot,encoding:'utf8',stdio:'pipe'}),/CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('exact frozen118 Git archive supplies all v4 Docker inputs while frozen117 rejects it',()=>{
 const root=backfillRoot,head='c8e3e3e9430edb0354c4af9192c9214fee663b0e',directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v4-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py'),run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v4',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);assert.deepEqual(verified,created);assert.equal(verified.migrationCount,117);assert.equal(verified.allGitBlobBytesVerified,true);
  for(const profile of ['connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3'])assert.throws(()=>execFileSync('python',[script,head,path.join(directory,profile+'.zip'),profile],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'})),dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from=')))for(const input of line.trim().split(/\s+/).slice(1,-1))assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  for(const name of ['reconstruction-v4-release-review.mjs','reconstruction-v4-runtime-preflight.mjs'])assert.ok(names.includes('infra/backend-release/'+name));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
let committedLookupIndex=false;
try{execFileSync('git',['cat-file','-e','HEAD:backend/migrations/119_accepted_source_event_lookup.sql'],{cwd:backfillRoot,stdio:'ignore'});committedLookupIndex=true;}catch{}
test('reconstruction119 archive refuses the frozen118 source instead of widening its profile',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v5-predecessor-'));
 try{assert.throws(()=>execFileSync('python',[path.join(backfillRoot,'infra/backend-release/backend-source-archive.py'),'c8e3e3e9430edb0354c4af9192c9214fee663b0e',path.join(directory,'source.zip'),'reconstruction-v5'],{cwd:backfillRoot,encoding:'utf8',stdio:'pipe'}),/CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('exact frozen119 Git archive supplies all v5 Docker inputs while frozen118 rejects it',{skip:!committedLookupIndex&&'Requires the exact committed119 candidate; local working files cannot qualify a Git archive'},()=>{
 const root=backfillRoot,head='88150a1f6efcd8c801c5f8071ad7ff1f21574f3b',directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v5-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py'),run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v5',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);assert.deepEqual(verified,created);assert.equal(verified.migrationCount,118);assert.equal(verified.allGitBlobBytesVerified,true);
  for(const profile of ['connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3','reconstruction-v4'])assert.throws(()=>execFileSync('python',[script,head,path.join(directory,profile+'.zip'),profile],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'})),dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from=')))for(const input of line.trim().split(/\s+/).slice(1,-1))assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  for(const name of ['reconstruction-v5-release-review.mjs','reconstruction-v5-runtime-preflight.mjs'])assert.ok(names.includes('infra/backend-release/'+name));
 }finally{rmSync(directory,{recursive:true,force:true});}
});

let committedShipmentWork=false;
try{execFileSync('git',['cat-file','-e','HEAD:backend/migrations/120_typed_shipment_projection_work.sql'],{cwd:backfillRoot,stdio:'ignore'});committedShipmentWork=true;}catch{}
test('reconstruction120 archive refuses the frozen119 source instead of widening its profile',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v6-predecessor-'));
 try{assert.throws(()=>execFileSync('python',[path.join(backfillRoot,'infra/backend-release/backend-source-archive.py'),'88150a1f6efcd8c801c5f8071ad7ff1f21574f3b',path.join(directory,'source.zip'),'reconstruction-v6'],{cwd:backfillRoot,encoding:'utf8',stdio:'pipe'}),/CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);}finally{rmSync(directory,{recursive:true,force:true});}
});
test('exact committed120 Git archive supplies all v6 Docker inputs while frozen119 rejects it',{skip:!committedShipmentWork&&'Requires the exact committed120 candidate; local working files cannot qualify a Git archive'},()=>{
 const root=backfillRoot,head='66a258e9eaeaea7695fff18f76ce0de3212c0573',directory=mkdtempSync(path.join(tmpdir(),'reconstruction-v6-source-'));
 try{
  const archive=path.join(directory,'source.zip'),script=path.join(root,'infra/backend-release/backend-source-archive.py'),run=extra=>JSON.parse(execFileSync('python',[script,head,archive,'reconstruction-v6',...extra],{cwd:root,encoding:'utf8'}));
  const created=run([]),verified=run(['--verify']);assert.deepEqual(verified,created);assert.equal(verified.migrationCount,119);assert.equal(verified.allGitBlobBytesVerified,true);
  for(const profile of ['connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3','reconstruction-v4','reconstruction-v5'])assert.throws(()=>execFileSync('python',[script,head,path.join(directory,profile+'.zip'),profile],{cwd:root,encoding:'utf8',stdio:'pipe'}),/EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const names=JSON.parse(execFileSync('python',['-c','import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'})),dockerfile=execFileSync('git',['show',`${head}:backend/Dockerfile`],{cwd:root,encoding:'utf8'});
  for(const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY ')&&!line.includes('--from=')))for(const input of line.trim().split(/\s+/).slice(1,-1))assert.ok(names.some(name=>name===input||name.startsWith(input+'/')),`missing Docker COPY input ${input}`);
  for(const name of ['reconstruction-v6-release-review.mjs','reconstruction-v6-runtime-preflight.mjs'])assert.ok(names.includes('infra/backend-release/'+name));
 }finally{rmSync(directory,{recursive:true,force:true});}
});

const backfillHead='93274b085113dee70ee4fe7516b384cacfcd385e';
const currentHead=execFileSync('git',['rev-parse','HEAD'],{cwd:backfillRoot,encoding:'utf8'}).trim();
const workspaceHead='e9d1446d7872351f47ba66c2ed425f6f6d9e2f3d';
const shipmentHead='fb9f80ab2c6c4f013e794ad654f7ca55d168ac19';
for(const [profile,previousProfile,head,previousHead,count,inventory,pair] of [
 ['reconstruction-v7','reconstruction-v6',shipmentHead,'66a258e9eaeaea7695fff18f76ce0de3212c0573',120,
  '3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5','shipment-automation-pair.mjs'],
 ['reconstruction-v8','reconstruction-v7',backfillHead,shipmentHead,121,
  'ea1b7bd281d155919935362bd904a7cce80711c267c64090be84023d6dbbc804','backfill-automation-pair.mjs'],
 ['reconstruction-v10','reconstruction-v8',workspaceHead,'c1d9bad13ddbd2e20a70152d3c1a270d28dd57ec',122,
  'ce2f00a3cee6b8139fc6323830e787e781dab7780da93c8d4b23deaa742c1b4d','order-workspace-pair.mjs'],
 ['reconstruction-v11','reconstruction-v10',currentHead,workspaceHead,123,
  'd0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60','collector-version-pair.mjs'],
])test(profile+' archive verifies every Docker input and rejects adjacent catalogs', () => {
 const directory = mkdtempSync(path.join(tmpdir(), profile+'-source-'));
 const script = path.join(backfillRoot, 'infra/backend-release/backend-source-archive.py');
 const run = (source, profile, name, ...options) => execFileSync('python',
  [script, source, path.join(directory, name), profile, ...options],
  {cwd:backfillRoot, encoding:'utf8', stdio:'pipe'});
 try {
  const created = JSON.parse(run(head, profile, 'source.zip'));
  assert.deepEqual(JSON.parse(run(head, profile, 'source.zip', '--verify')), created);
  assert.equal(created.migrationCount, count);
  assert.equal(created.migrationInventorySha256, inventory);
  assert.equal(created.allGitBlobBytesVerified, true);
  assert.throws(() => run(head, previousProfile, 'wrong-profile.zip'), /EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  assert.throws(() => run(previousHead, profile, 'wrong-source.zip'),
   /CONNECT_PROBES_REQUIRED|EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH/);
  const archive = path.join(directory, 'source.zip');
  const inspection = JSON.parse(execFileSync('python', ['-c',
   "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([z.namelist(),z.read('backend/Dockerfile').decode()]))", archive],
   {encoding:'utf8'}));
  const [names, dockerfile] = inspection;
  for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
   for (const input of line.trim().split(/\s+/).slice(1, -1)) {
    assert.ok(names.some(name => name === input || name.startsWith(input + '/')), 'missing Docker COPY input ' + input);
   }
  }
  // Build the actual /release directory, including Docker COPY instructions
  // that put multiple modules into a directory. Loading the preflight detects
  // imports omitted by the Dockerfile even if a module exists in the archive.
  const installed = new Set();
  for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))) {
   const [, ...paths] = line.trim().split(/\s+/);
   const destination = paths.pop();
   if (!destination.startsWith('/release/')) continue;
   for (const source of paths) {
    const name = destination.endsWith('/') ? path.posix.basename(source) : path.posix.basename(destination);
    const raw = execFileSync('python', ['-c',
     'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archive, source]);
    writeFileSync(path.join(directory, name), raw);
    installed.add(name);
   }
  }
  for (const probe of [profile+'-runtime-preflight.mjs',profile+'-release-review.mjs',pair]) {
   assert.ok(installed.has(probe), 'missing runtime probe ' + probe);
  }
  assert.throws(() => execFileSync(process.execPath, [path.join(directory,profile+'-runtime-preflight.mjs'), 'api'],
   {cwd:directory, env:{}, stdio:'pipe'}), /RECONSTRUCTION_REVIEW_BINDING_REQUIRED/);
 } finally {
  rmSync(directory, {recursive:true, force:true});
 }
});
