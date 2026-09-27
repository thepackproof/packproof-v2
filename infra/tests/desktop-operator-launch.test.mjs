import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateDesktopOperatorRequest,executeDesktopOperator,buildDesktopOperatorCommand} from '../desktop-operator-launch.mjs';
const source='d45727b8648ade030642a011c280c10bce525591',host='packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com';
const url=`https://${host}/desktop/${source}/operator-bundle.json.gz?X-Amz-Signature=${'b'.repeat(64)}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const payload=()=>{const content='export async function main() {}';return {files:[{name:'desktop-capture-migration.mjs',content,sha256:sha(content)}]};};
const encode=value=>gzipSync(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));
const request=bytes=>({url,bundleSha256:sha(bytes),args:['--inspect',source]});
const response=bytes=>new Response(bytes,{status:200,headers:{'content-type':'application/gzip'}});
const safe=promise=>assert.rejects(promise,error=>error.message==='DESKTOP_OPERATOR_FAILED'&&!error.cause);
async function injected(work){
 const next={PACKPROOF_DESKTOP_MIGRATION_OPERATOR:'OWNER_COMPONENTS_INJECTED',PACKPROOF_DB_USER:'packproof',PACKPROOF_DB_PASSWORD:'test-injected-owner-password',DATABASE_URL:'postgres://runtime:wrong@wrong/db',PACKPROOF_DB_SECRET_ARN:'runtime-secret-callback'};
 const prior=Object.fromEntries(Object.keys(next).map(key=>[key,process.env[key]]));
 try{Object.assign(process.env,next);return await work();}finally{for(const[key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
const config=async()=>({loadConfig:env=>{
 assert.equal(env.DATABASE_URL,'');assert.equal(env.PACKPROOF_DB_SECRET_ARN,'');
 return {databaseUrl:`postgres://packproof:owner-injected@${host}/packproof_v2?sslmode=verify-full`};
}});

test('request pins exact bucket/path/source and allows no other operator, argument or destination',()=>{
 const valid=request(encode(payload()));validateDesktopOperatorRequest(valid);
 for(const change of [
   {url:url.replace('https:','http:')},{url:url.replace(host,`${host}.attacker.example`)},
   {url:url.replace(host,`user:password@${host}`)},{url:url.replace(host,`${host}:8443`)},
   {url:url+'#fragment'},{url:url.replace('/desktop/','/admin/')},{url:url.replace(source,'a'.repeat(40))},
   {url:url.replace('/operator-bundle','/unused/../operator-bundle')},{url:url.replace('/operator-bundle','/%2e%2e/operator-bundle')},
   {args:['--inspect','a'.repeat(40)]},{args:['--apply',source,'extra']},{args:['--delete',source]},
   {entry:'admin-runtime-credentials.mjs'},{bundleSha256:'unreviewed'},
 ])assert.throws(()=>validateDesktopOperatorRequest({...valid,...change}),/DESKTOP_OPERATOR_REQUEST_INVALID/);
});

test('bounded network/decompression and whole file hashes fail before any execution',async()=>{
 const bytes=encode(payload());let imported=false;
 const importModule=async()=>{imported=true;};
 for(const fetchImpl of [async()=>{throw Error('secret-presign');},async()=>new Response(null,{status:302}),async()=>new Response(bytes,{headers:{'content-length':'131073'}}),async()=>new Response(bytes,{headers:{'content-encoding':'gzip'}}),async()=>new Response(Buffer.alloc(131073))])await safe(executeDesktopOperator(request(bytes),{fetchImpl,importModule}));
 for(const bad of [Buffer.from('not-gzip'),encode('{invalid'),encode(Buffer.from([255,254])),encode('x'.repeat(524289))])await safe(executeDesktopOperator(request(bad),{fetchImpl:async()=>response(bad),importModule}));
 await safe(executeDesktopOperator({...request(bytes),bundleSha256:'0'.repeat(64)},{fetchImpl:async()=>response(bytes),importModule}));
 for(const mutate of [b=>b.files.push(b.files[0]),b=>b.files[0].name='../desktop-capture-migration.mjs',b=>b.files[0].content+='changed',b=>b.files[0].name='admin-runtime-credentials.mjs',b=>b.files[0].mode=511,b=>b.extra=true]){const p=payload();mutate(p);const bad=encode(p);await safe(executeDesktopOperator(request(bad),{fetchImpl:async()=>response(bad),importModule}));}
 assert.equal(imported,false);
});

test('fetch cancellation is bounded and never includes raw provider errors',async()=>{
 let aborted=false;const bytes=encode(payload());
 await safe(executeDesktopOperator(request(bytes),{timeoutMs:5,fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.headers['Accept-Encoding'],'identity');return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('database-password'));},{once:true}));}}));
 assert.equal(aborted,true);
});

test('transport requires explicit injected owner components and never revives an ambient runtime URL',async()=>injected(async()=>{
 const bytes=encode(payload());let configCalls=0;
 const dependencies={fetchImpl:async()=>response(bytes),importConfig:async()=>{configCalls++;return (await config());},importModule:async()=>({main:async()=>{
  assert.match(process.env.PACKPROOF_DESKTOP_MIGRATION_DATABASE_URL,/owner-injected/);
  assert.equal(process.env.PACKPROOF_DESKTOP_MIGRATION_DB_SECRET_ARN,'');assert.equal(process.env.PACKPROOF_DB_SECRET_ARN,'');
 }})};
 await executeDesktopOperator(request(bytes),dependencies);assert.equal(configCalls,1);
 assert.equal(process.env.PACKPROOF_DB_SECRET_ARN,'runtime-secret-callback');
 for(const key of ['PACKPROOF_DESKTOP_MIGRATION_OPERATOR','PACKPROOF_DB_USER','PACKPROOF_DB_PASSWORD']){const prior=process.env[key];delete process.env[key];await safe(executeDesktopOperator(request(bytes),dependencies));process.env[key]=prior;}
 assert.equal(configCalls,1);
}));

test('private exclusive operator file is verified before import and removed after success/failure',async()=>injected(async()=>{
 const bytes=encode(payload());
 for(const failure of [null,'import','main']){
  let directory;
  const work=executeDesktopOperator(request(bytes),{fetchImpl:async()=>response(bytes),importConfig:config,importModule:async url=>{
   const path=fileURLToPath(url);directory=path.slice(0,path.lastIndexOf('/'));
   assert.match(directory,/^\/tmp\/packproof-desktop-operator-[A-Za-z0-9]+$/);assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(await readFile(path,'utf8'),payload().files[0].content);
   if(failure==='import')throw Error('private-token');return {main:async args=>{assert.deepEqual(args,['--inspect',source]);if(failure==='main')throw Error('private-token');}};
  }});
  if(failure)await safe(work);else await work;
  await assert.rejects(stat(directory),{code:'ENOENT'});
 }
}));

test('structured transport stays within ECS override budget with long signed URL and required evidence',()=>{
 const valid=request(encode(payload()));valid.url+='&X-Amz-Security-Token='+encodeURIComponent('x+/='.repeat(130));
 const command=buildDesktopOperatorCommand(valid);assert.deepEqual(command.slice(0,3),['node','--input-type=module','-e']);
 const override={containerOverrides:[{name:'packproof-api',command,environment:[
  {name:'PACKPROOF_DESKTOP_MIGRATION_OPERATOR',value:'OWNER_COMPONENTS_INJECTED'},
  {name:'PACKPROOF_DESKTOP_MIGRATION_RECOVERY_POINT',value:'2026-09-27T12:30:00Z'},
  {name:'PACKPROOF_DESKTOP_MIGRATION_RECOVERY_DB_ID',value:'packproof-v2-staging-db'},
  {name:'PACKPROOF_DESKTOP_MIGRATION_INSPECTED_AT',value:'2026-09-27T12:31:00Z'},
  {name:'PACKPROOF_DESKTOP_MIGRATION_INSPECTION_SHA256',value:'a'.repeat(64)},
 ]}]};
 assert.ok(Buffer.byteLength(JSON.stringify(override))<8192);
 const failed=spawnSync(process.execPath,[...command.slice(1,3),`globalThis.fetch=async()=>{throw Error('private-presign');};\n${command[3]}`],{encoding:'utf8'});
 assert.equal(failed.status,1);assert.equal(failed.stderr,'');assert.deepEqual(JSON.parse(failed.stdout),{event:'desktop_operator_failed',code:'DESKTOP_OPERATOR_FAILED'});
});
