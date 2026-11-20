const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect, publish } = require('../scripts/publish-release.cjs');

const hash = (bytes, alg = 'sha256', encoding = 'hex') => crypto.createHash(alg).update(bytes).digest(encoding);
const commit = 'a'.repeat(40);
const webOrigin = 'https://dvpmnwc27i8tw.cloudfront.net', apiOrigin = 'https://api.example.com';
const url = 'https://downloads.thepackproof.com/connect/production/win32/x64/';

function fixture(t, version = '0.6.0') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const exe = 'PackProof-Connect-production-Setup-' + version + '.exe';
  const binary = 'Synthetic installer with version ' + version, sha512 = hash(binary, 'sha512', 'base64');
  const yml = JSON.stringify({ version, path: exe, sha512, files: [{ url: exe, sha512, size: binary.length }] });
  const list = [[exe, binary], [exe + '.blockmap','Synthetic blockmap'], ['latest.yml', yml]];
  const files = list.map(([file, text]) => {
    fs.writeFileSync(path.join(directory, file), text);
    return { file, bytes: Buffer.byteLength(text), sha256: hash(text) };
  });
  const evidence = { product:'PackProof Connect', sourceCommit:commit, signed:true, sourceDirty:false, channel:'production',
    version, application:{schema:'packproof.connect-build/v1', sourceCommit:commit, sourceDirty:false, channel:'production', appVersion:version},
    artifacts:files.slice(0,1), feed:{publisher:'Synthetic publisher',url,apiOrigin,webOrigin,files:files.slice(1)} };
  const writeReport = () => fs.writeFileSync(path.join(directory, 'release-evidence.json'), JSON.stringify(evidence));
  writeReport();
  const options = { channel:'production', commit, installerHash:files[0].sha256, apiOrigin, webOrigin };
  const env = { APP_ENV:'production', GITHUB_SHA:commit, CONNECT_INSTALLER_SHA256:options.installerHash,
    PACKPROOF_RELEASE_BUCKET:'qualified-bucket', PACKPROOF_WEB_BASE_URL:webOrigin, PACKPROOF_API_BASE_URL:apiOrigin };
  return { directory, exe, files, evidence, options, env, writeReport };
}

function store() {
  const objects = new Map(), writes = [];
  function execute(args) {
    const argument = key => args[args.indexOf(key) + 1];
    const key = argument(args.includes('--key') ? '--key' : '--prefix');
    const current = objects.get(key);
    switch (args[1]) {
      case 'list-objects-v2': return JSON.stringify({ Contents: current ? [{ Key: key }] : [] });
      case 'head-object': return JSON.stringify({ ETag:current.etag, Metadata:{sha256:hash(current.bytes)},
        ContentLength:current.bytes.length, ChecksumSHA256:hash(current.bytes,'sha256','base64') });
      case 'get-object':
        assert.equal(argument('--if-match'),current.etag);
        fs.writeFileSync(args.at(-1),current.bytes);
        return '{}';
      case 'put-object': {
        if (current) assert.equal(argument('--if-match'),current.etag);
        else assert.equal(argument('--if-none-match'),'*');
        const bytes=fs.readFileSync(argument('--body'));
        assert.equal(argument('--checksum-sha256'), hash(bytes,'sha256','base64'));
        writes.push(key); objects.set(key,{bytes,etag:'"'+hash(bytes)+'"'}); return '{}';
      }
      default: throw Error('Unexpected storage operation ' + args[1]);
    }
  }
  const fetch = async u => { const obj=objects.get(new URL(u).pathname.slice(1));return new Response(obj?.bytes,{ status:obj?200:404 }); };
  return { objects, writes, execute, fetch };
}

test('only the reviewed channel, installer hash, hosted endpoints, signed original and feed bytes qualify', async t => {
  const f=fixture(t);
  await inspect(f.directory,f.options);
  for (const options of [{channel:'development'},{commit:'b'.repeat(40)},{webOrigin:'https://other.example'},{installerHash:'f'.repeat(64)},{unifiedWindows:true}]) {
    await assert.rejects(inspect(f.directory,{...f.options,...options}));
  }
  f.evidence.application.unifiedWindows=true; f.writeReport();
  await inspect(f.directory,{...f.options,unifiedWindows:true});
  await assert.rejects(inspect(f.directory,f.options));
  f.evidence.application.unifiedWindows=false;
  f.evidence.signed=false; f.writeReport();
  await assert.rejects(inspect(f.directory,f.options));
  f.evidence.signed=true; f.writeReport();
  fs.writeFileSync(path.join(f.directory,f.exe+'.blockmap'),'replacement');
  await assert.rejects(inspect(f.directory,f.options), /hash or length/);
});

test('rejects out-of-scope metadata even when its file hash matches the build receipt',async t=>{
  const f=fixture(t), entry=f.evidence.feed.files[1];
  const raw=JSON.parse(fs.readFileSync(path.join(f.directory,'latest.yml')));
  raw.files[0].url='https://other.example/setup.exe';
  const data=JSON.stringify(raw); fs.writeFileSync(path.join(f.directory,'latest.yml'),data);
  entry.bytes=Buffer.byteLength(data); entry.sha256=hash(data); f.writeReport();
  await assert.rejects(inspect(f.directory,f.options), /updater metadata/);
});

test('publishes immutable binaries before the feed, retries partial uploads, and refuses downgrade',async t=>{
  const f=fixture(t), storage=store();
  const failBlockmap=async u=>u.endsWith('.blockmap') ? new Response('bad') : storage.fetch(u);
  await assert.rejects(publish(f.directory,f.env,storage.execute,failBlockmap), /different bytes/);
  assert.ok(!storage.writes.some(k=>k.endsWith('latest.yml')));
  const result=await publish(f.directory,f.env,storage.execute,storage.fetch);
  assert.equal(result.installer,url+f.exe);
  assert.equal(storage.writes.length,3);assert.ok(storage.writes.at(-1).endsWith('latest.yml'));
  await publish(f.directory,f.env,storage.execute,storage.fetch);
  assert.equal(storage.writes.length,3);
  const prior=fixture(t,'0.5.0');
  await assert.rejects(publish(prior.directory,prior.env,storage.execute,storage.fetch), /newer release/);
  assert.equal(storage.writes.length,3);
});
