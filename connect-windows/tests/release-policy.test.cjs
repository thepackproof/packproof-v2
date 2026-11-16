const {test}=require('node:test');const assert=require('node:assert/strict');
const {context,validate,trustedUrl}=require('../scripts/release-policy.cjs');
test('Connect environments never overwrite capture identity or each other',()=>{const all=['development','staging','production'].map(APP_ENV=>context({APP_ENV}));assert.equal(new Set(all.map(x=>x.appId)).size,3);assert.equal(new Set(all.map(x=>x.serviceName)).size,3);for(const x of all){assert.match(x.updateUrl,/\/connect\//);assert.doesNotMatch(x.appId,/desktop/);}});
test('signed packages require native Windows and signing identity',()=>{assert.throws(()=>validate({APP_ENV:'production'},'linux'),/native Windows/);assert.throws(()=>validate({APP_ENV:'production'},'win32'),/required/);});
test('endpoint configuration disallows credentials/query/HTTP',()=>{for(const u of ['http://thepackproof.com','https://x:y@thepackproof.com/','https://thepackproof.com/?token=a'])assert.equal(trustedUrl(u),false);assert.equal(trustedUrl('https://thepackproof.com'),true);});

const {readFileSync}=require('node:fs');const {join}=require('node:path');
test('Windows service config is written BOM-free for System.Text.Json startup',()=>{
 const installer=readFileSync(join(__dirname,'../installer/lifecycle.ps1'),'utf8');
 assert.match(installer,/WriteAllText\(\$serviceConfigPath/);
 assert.match(installer,/UTF8Encoding\(\$false\)/);
 assert.doesNotMatch(installer,/\$serviceConfig\s*\|\s*ConvertTo-Json[^\n]*Set-Content[^\n]*Encoding\s+utf8/i);
});

test('bridge trust checks reject non-service peers and invalid service accounts before data transfer',()=>{
 const bridge=readFileSync(join(__dirname,'../bridge/Program.cs'),'utf8');
 assert.match(bridge,/GetNamedPipeServerProcessId\(pipe\.SafePipeHandle/);
 assert.match(bridge,/pid != registered\.Pid/);
 assert.match(bridge,/SERVICE_PIPE_PEER_MISMATCH/);
 assert.match(bridge,/SERVICE_ACCOUNT_MISMATCH/);
 assert.match(bridge,/TrustedBinaryPath\(registered\.BinaryPath\)/);
 assert.match(bridge,/VerifyProcessImageWhenAccessible\(pid, expected\)/);
 assert.match(bridge,/if \(Marshal\.GetLastWin32Error\(\) == 5\) return/);
 assert.match(bridge,/await pipe\.WriteAsync/);
});

test('native service smoke contains one coherent PowerShell test harness',()=>{
 const smoke=readFileSync(join(__dirname,'../scripts/smoke-native-foundation.ps1'),'utf8').replace(/\r\n/g,'\n');
 const count=expression=>smoke.split(expression).length-1;
 assert.equal(count('function Invoke-Bridge('),1);
 assert.equal(count('function Run-Lifecycle('),1);
 assert.equal(count("Add-Type -Path"),1);
 assert.equal(count("finally {\n if ($operatorTemporarilyChanged"),1);
 assert.match(smoke,/Native verified bridge refused trusted service:/);
 assert.ok(smoke.trimEnd().endsWith('}'));
});

test('candidate provenance detects a stale packaged renderer, changed assets and dirty release source',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
 const {tmpdir}=require('node:os');
 const {writeBuildProvenance,verifyBuildProvenance,verifyPackagedProvenance}=await import('../scripts/build-provenance.mjs');
 const asar=require('@electron/asar');
 const root=await mkdtemp(join(tmpdir(),'connect-provenance-'));
 const archive=join(root,'candidate.asar'),app=join(root,'app');
 const sourceCommit='a'.repeat(40),channel='development';
 try{
  await mkdir(join(app,'dist/main'),{recursive:true});await mkdir(join(app,'dist/renderer/assets'),{recursive:true});
  await writeFile(join(app,'package.json'),JSON.stringify({version:'0.1.2'}));
  await writeFile(join(app,'dist/main/index.cjs'),'main fixture');await writeFile(join(app,'dist/renderer/assets/ui.js'),'review fixture');
  const manifest=await writeBuildProvenance(app,{sourceCommit,channel,sourceDirty:false,appVersion:'0.1.2'});
  await asar.createPackage(app,archive);
  assert.equal((await verifyPackagedProvenance(archive,{sourceCommit,channel})).assets.length,2);
  await assert.rejects(()=>verifyPackagedProvenance(archive,{sourceCommit:'b'.repeat(40),channel}),/does not match/);
  await writeFile(join(app,'dist/renderer/assets/ui.js'),'different UI');
  await assert.rejects(()=>verifyBuildProvenance(app,{sourceCommit,channel}),/assets differ/);
  const staleArchive=join(root,'stale.asar');await asar.createPackage(app,staleArchive);
  await assert.rejects(()=>verifyPackagedProvenance(staleArchive,{sourceCommit,channel}),/assets differ/);
  await writeFile(join(app,'dist/renderer/assets/ui.js'),'review fixture');
  await writeFile(join(app,'dist/renderer/assets/extra.js'),'unexpected asset');
  await assert.rejects(()=>verifyBuildProvenance(app,{sourceCommit,channel}),/assets differ/);
  await rm(join(app,'dist/renderer/assets/extra.js'));
  await writeFile(join(app,'dist/main/build-provenance.json'),JSON.stringify({...manifest,sourceDirty:true}));
  await assert.rejects(()=>verifyBuildProvenance(app,{sourceCommit,channel,requireClean:true}),/clean committed source/);
 }finally{asar.uncacheAll();await rm(root,{recursive:true,force:true});}
});
