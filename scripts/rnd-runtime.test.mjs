import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sign,verify} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,chmodSync,symlinkSync,unlinkSync,mkdirSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeRuntime,prepareRuntime} from './rnd-runtime.mjs';

const root=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
const cli=resolve(root,'scripts/rnd-runtime.mjs');
function workspace(t){const p=mkdtempSync(resolve(tmpdir(),'packproof-runtime-test-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
function run(...args){const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});if(result.error)throw result.error;return result;}
function fixture(t){return initializeRuntime(resolve(workspace(t),'research'));}
const posix={skip:process.platform==='win32'};

test('CLI initialization creates private usable signing material and never overwrites a second time',t=>{
 const directory=resolve(workspace(t),'new','research'),result=run('init','--dir',directory);
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(readdirSync(directory).sort(),['public-trust.json','runtime.json','signing-key.pem']);
 if(process.platform!=='win32'){
  assert.equal(statSync(directory).mode&0o777,0o700);
  for(const name of readdirSync(directory))assert.equal(statSync(resolve(directory,name)).mode&0o777,0o600);
 }
 const original=Object.fromEntries(readdirSync(directory).map(name=>[name,readFileSync(resolve(directory,name),'utf8')]));
 const config=JSON.parse(original['runtime.json']),trust=JSON.parse(original['public-trust.json']);
 assert.match(config.uploadSecret,/^[a-f0-9]{64}$/);
 assert.equal(trust.keys[0].keyId,config.keyId);
 const message=Buffer.from('local fixture signing check');
 assert.equal(verify('sha256',message,trust.keys[0].publicKeyPem,sign('sha256',message,original['signing-key.pem'])),true);
 assert.notEqual(run('init','--dir',directory).status,0);
 for(const [name,bytes] of Object.entries(original))assert.equal(readFileSync(resolve(directory,name),'utf8'),bytes);
 assert.doesNotMatch(result.stdout,new RegExp(config.uploadSecret));
 assert.doesNotMatch(result.stdout,/BEGIN PRIVATE KEY/);
});

test('initialization rejects direct and parent-symlink repository paths before creating anything',posix,t=>{
 const temporary=workspace(t),target=resolve(root,`runtime-security-test-${process.pid}`);
 assert.equal(existsSync(target),false);
 t.after(()=>{if(existsSync(target))rmSync(target,{recursive:true,force:true});});
 assert.notEqual(run('init','--dir',target).status,0);
 assert.equal(existsSync(target),false);
 const link=resolve(temporary,'source');symlinkSync(root,link,'dir');
 const result=run('init','--dir',resolve(link,`runtime-security-test-${process.pid}`,'nested'));
 assert.notEqual(result.status,0);assert.match(result.stderr,/outside the source repository/);
 assert.equal(existsSync(target),false);
 const dangling=resolve(temporary,'dangling');symlinkSync(resolve(temporary,'missing'),dangling);
 assert.notEqual(run('init','--dir',dangling).status,0);
 assert.equal(existsSync(resolve(temporary,'missing')),false);
});

test('parent credentials, flags, home, executable search path and Node injection never reach the API',t=>{
 const directory=fixture(t),parent={
  AWS_ACCESS_KEY_ID:'cloud-id',AWS_SECRET_ACCESS_KEY:'cloud-secret',AWS_PROFILE:'production',
  AWS_SHARED_CREDENTIALS_FILE:'/ordinary/credentials',AWS_CONTAINER_CREDENTIALS_FULL_URI:'http://metadata',
  DATABASE_URL:'postgres://production',PACKPROOF_DB_SECRET_ARN:'secret',STRIPE_SECRET_KEY:'billing',
  PACKPROOF_OBJECT_STORAGE:'s3',PACKPROOF_COGNITO_CLIENT_ID:'live-client',PACKPROOF_ENVIRONMENT:'production',
  PACKPROOF_MANIFEST_SIGNING_KEY_FILE:'/ordinary/key.pem',PACKPROOF_RND_ENABLED:'1',PACKPROOF_RND_KILL_SWITCH:'0',
  PACKPROOF_RND_PROOFPRINT_COLLECTION:'1',PACKPROOF_RND_PROOFPRINT_CUSTOMER_DISPLAY:'1',PACKPROOF_DISTRIBUTION_AUTHORIZED:'true',
  PACKPROOF_RND_LEARNING_TRUST_KEYS:'unapproved',PACKPROOF_RND_WITNESS_KEY:'/ordinary/log-key',
  HOME:'/ordinary/home',PATH:'/attacker/bin',NODE_OPTIONS:'--import /attacker/module.mjs',NODE_PATH:'/attacker/modules',
  HTTP_PROXY:'http://credential-proxy',PYTHONPATH:'/attacker/python',
  PACKPROOF_RND_PYTHON:'/private/venv/bin/python',PACKPROOF_RND_WORKER_SCRIPT:'/research/vision/worker.py',
 };
 const spec=prepareRuntime({directory},parent),env=spec.options.env;
 assert.equal(spec.program,process.execPath);assert.equal(spec.options.shell,false);assert.equal(spec.options.cwd,directory);
 for(const name of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_PROFILE','AWS_SHARED_CREDENTIALS_FILE','AWS_CONTAINER_CREDENTIALS_FULL_URI','DATABASE_URL','PACKPROOF_DB_SECRET_ARN','STRIPE_SECRET_KEY','PACKPROOF_COGNITO_CLIENT_ID','NODE_OPTIONS','NODE_PATH','HTTP_PROXY','PYTHONPATH','PACKPROOF_RND_PROOFPRINT_COLLECTION','PACKPROOF_RND_PROOFPRINT_CUSTOMER_DISPLAY','PACKPROOF_RND_LEARNING_TRUST_KEYS','PACKPROOF_RND_WITNESS_KEY'])assert.equal(env[name],undefined,name);
 assert.equal(env.HOME,directory);assert.doesNotMatch(env.PATH,/attacker/);
 assert.equal(env.PGLITE_DIR,resolve(directory,'research-db'));assert.equal(env.PACKPROOF_OBJECT_STORAGE,'local');
 assert.equal(env.PACKPROOF_RND_ENABLED,'0');assert.equal(env.PACKPROOF_RND_KILL_SWITCH,'1');
 assert.equal(env.PACKPROOF_DISTRIBUTION_AUTHORIZED,'false');assert.equal(env.PACKPROOF_ENVIRONMENT,'research');
 assert.equal(env.PACKPROOF_RND_PYTHON,parent.PACKPROOF_RND_PYTHON);
 assert.equal(env.PACKPROOF_MANIFEST_SIGNING_KEY_FILE,resolve(directory,'signing-key.pem'));
 const selected=prepareRuntime({directory,port:4317,features:['proofprint']},parent).options.env;
 assert.equal(selected.PACKPROOF_PUBLIC_URL,'http://127.0.0.1:4317');
 assert.equal(selected.PACKPROOF_RND_PROOFPRINT_COLLECTION,'1');assert.equal(selected.PACKPROOF_RND_VERIFIEDCAPTURE_COLLECTION,undefined);
 assert.equal(selected.PACKPROOF_RND_PROOFPRINT_CUSTOMER_DISPLAY,undefined);
});

test('serve refuses copied dotenv credentials and data symlinks before any child starts',posix,t=>{
 const directory=fixture(t),external=workspace(t);
 writeFileSync(resolve(directory,'.env'),'AWS_PROFILE=production\n',{mode:0o600});
 const denied=run('serve','--dir',directory);assert.notEqual(denied.status,0);assert.match(denied.stderr,/\.env/);
 assert.equal(existsSync(resolve(directory,'research-db')),false);
 unlinkSync(resolve(directory,'.env'));
 symlinkSync(external,resolve(directory,'research-db'),'dir');
 assert.throws(()=>prepareRuntime({directory}),/without symlinks/);
 assert.deepEqual(readdirSync(external),[]);
 unlinkSync(resolve(directory,'research-db'));mkdirSync(resolve(directory,'research-db'));
 symlinkSync(external,resolve(directory,'research-db/objects'),'dir');
 assert.throws(()=>prepareRuntime({directory}),/without symlinks/);
});

test('serve rejects public and linked private material, malformed secrets, and unrelated signing keys',posix,t=>{
 const directory=fixture(t),key=resolve(directory,'signing-key.pem');
 chmodSync(directory,0o755);assert.throws(()=>prepareRuntime({directory}),/private directory/);chmodSync(directory,0o700);
 chmodSync(key,0o644);assert.throws(()=>prepareRuntime({directory}),/private runtime file/);chmodSync(key,0o600);
 const original=readFileSync(key),external=resolve(workspace(t),'ordinary.pem');
 writeFileSync(external,original,{mode:0o600});unlinkSync(key);symlinkSync(external,key);
 assert.throws(()=>prepareRuntime({directory}),/private runtime file/);
 unlinkSync(key);writeFileSync(key,original,{mode:0o600});
 const configFile=resolve(directory,'runtime.json'),config=JSON.parse(readFileSync(configFile,'utf8'));
 writeFileSync(configFile,JSON.stringify({...config,uploadSecret:'ordinary-secret'}));
 assert.throws(()=>prepareRuntime({directory}),/Invalid isolated runtime config/);
 writeFileSync(configFile,JSON.stringify(config));
 const other=fixture(t);writeFileSync(key,readFileSync(resolve(other,'signing-key.pem')));
 assert.throws(()=>prepareRuntime({directory}),/signing material and trust policy/);
});

test('bad feature flags, ports and ambiguous CLI arguments cannot start a runtime',t=>{
 const directory=fixture(t);
 for(const port of [0,80,65536,1.5,'http://remote:3000'])assert.throws(()=>prepareRuntime({directory,port}),/Invalid local port/);
 assert.throws(()=>prepareRuntime({directory,features:['F99']}),/Unknown research feature/);
 for(const args of [['--dir'],['--dir',directory,'--dir',directory],['--dir',directory,'--env','production']])assert.notEqual(run('serve',...args).status,0);
});
