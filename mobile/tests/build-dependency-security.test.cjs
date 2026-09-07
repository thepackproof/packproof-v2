const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('dependency patches are checked and idempotent', () => {
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, ['scripts/secure-build-dependencies.cjs'], {cwd:root,encoding:'utf8',timeout:5000});
    assert.equal(run.status,0,run.stderr);
  }
});

test('renamed ICNS/JXL/HEIF zero-length payloads reject before parser loops', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'packproof-images-'));
  try {
    const icns=Buffer.alloc(24);icns.write('icns');icns.writeUInt32BE(24,4);icns.write('icp4',8);
    const jxl=Buffer.alloc(40);jxl.writeUInt32BE(12,0);jxl.write('JXL ',4);jxl.write('ftyp',16);jxl.write('jxl ',20);
    const heif=Buffer.alloc(40);heif.write('ftyp',4);heif.write('heic',8);
    for(const [index,payload] of [icns,jxl,heif].entries()) {
      const file=path.join(temp,`${index}.png`);fs.writeFileSync(file,payload);
      const script=`const s=require('image-size'),fs=require('fs'),assert=require('assert'); for(const input of [process.argv[1],fs.readFileSync(process.argv[1])]) assert.throws(()=>s(input),/PackProof build does not accept/); s(process.argv[1],error=>{assert.match(error.message,/PackProof build does not accept/)});`;
      const run=spawnSync(process.execPath,['-e',script,file],{cwd:root,encoding:'utf8',timeout:2000});
      assert.equal(run.status,0,run.error?.message || run.stderr);
    }
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

test('Metro callable buffer and synchronous file image APIs retain PNG dimensions', () => {
  const imageSize=require('image-size');
  const file=path.join(root,'assets/icon.png');
  const expected=imageSize(file);
  assert.ok(expected.width>0&&expected.height>0);
  assert.deepEqual(imageSize(fs.readFileSync(file)),expected);
  const metro=require('metro/src/Assets');
  assert.deepEqual(metro.getAssetSize('png',fs.readFileSync(file),file),{width:expected.width,height:expected.height});
});

test('Expo streaming tar extraction works with patched tar 7 and rejects traversal', async () => {
  const tar=require('tar');
  assert.equal(require('tar/package.json').version,'7.5.22');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'packproof-tar-'));
  try {
    const source=path.join(temp,'source'),target=path.join(temp,'target');
    fs.mkdirSync(path.join(source,'package'),{recursive:true});fs.writeFileSync(path.join(source,'package','fixture.txt'),'original');
    const archive=path.join(temp,'fixture.tgz');
    await tar.c({cwd:source,file:archive,gzip:true},['package']);
    const expo=require('@expo/cli/build/src/utils/npm');
    await expo.extractLocalNpmTarballAsync(archive,{cwd:target,name:'fixture'});
    assert.equal(fs.readFileSync(path.join(target,'fixture.txt'),'utf8'),'original');
    const maliciousHeader=new tar.Header({path:'../outside.txt',size:4,type:'File',mode:0o644});
    maliciousHeader.encode();
    const payload=Buffer.concat([maliciousHeader.block,Buffer.from('evil'),Buffer.alloc(508),Buffer.alloc(1024)]);
    const warnings=[];const extract=tar.x({cwd:target,onwarn:code=>warnings.push(code)});
    await new Promise((resolve,reject)=>{extract.on('close',resolve);extract.on('error',reject);extract.end(payload);});
    assert.equal(fs.existsSync(path.join(temp,'outside.txt')),false);
    assert.ok(warnings.includes('TAR_ENTRY_ERROR'));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
