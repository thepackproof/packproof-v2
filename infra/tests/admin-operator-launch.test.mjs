import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateAdminOperatorRequest,executeAdminOperator,buildAdminOperatorCommand} from '../admin-operator-launch.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const host='packproof-v2-staging-build-784514617543.s3.us-east-1.amazonaws.com';
const url=`https://${host}/admin/${'a'.repeat(40)}/operator-bundle.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${'b'.repeat(64)}`;
const script='export async function main() {}';
const names=['admin-dashboard-migration.mjs','admin-runtime-credentials.mjs','runtime-roles.sql'];
const payload=()=>({files:names.map(name=>{const content=name.endsWith('.sql')?'SELECT 1;':script;return{name,content,sha256:hash(content)};})});
const encode=value=>gzipSync(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));
const request=(bytes,entry='admin-runtime-credentials.mjs')=>({url,bundleSha256:hash(bytes),entry,args:entry==='admin-dashboard-migration.mjs'?['--inspect','c'.repeat(40)]:['--inspect','c'.repeat(40),'d'.repeat(64),'e'.repeat(64),'$RUNTIME_ROLES_SQL']});
const response=bytes=>new Response(bytes,{status:200,headers:{'content-type':'application/gzip'}});
const rejectsSafe=promise=>assert.rejects(promise,error=>error.message==='ADMIN_OPERATOR_FAILED'&&!error.cause);

test('request admits only the exact HTTPS bucket/key, fixed entries and positional arguments',()=>{
  const valid=request(encode(payload()));validateAdminOperatorRequest(valid);
  for(const invalid of [
    {...valid,url:valid.url.replace('https:','http:')},
    {...valid,url:valid.url.replace(host,`${host}.attacker.example`)},
    {...valid,url:valid.url.replace(host,`user:secret@${host}`)},
    {...valid,url:valid.url.replace(host,`${host}:8443`)},
    {...valid,url:`${valid.url}#fragment`},
    {...valid,url:valid.url.replace('/admin/','/other/')},
    {...valid,url:valid.url.replace('operator-bundle.json.gz','../operator-bundle.json.gz')},
    {...valid,url:valid.url.replace('operator-bundle.json.gz','%2e%2e%2foperator-bundle.json.gz')},
    {...valid,url:valid.url.replace('a'.repeat(40),'A'.repeat(40))},
    {...valid,entry:'../../app/dist/server.js'},
    {...valid,entry:'runtime-roles.sql'},
    {...valid,args:[...valid.args,'extra']},
    {...valid,args:['--apply',valid.args[1],valid.args[2],valid.args[3],'/tmp/unreviewed.sql']},
    {...valid,extra:'unreviewed'},
    {...valid,bundleSha256:'bad'},
  ])assert.throws(()=>validateAdminOperatorRequest(invalid),error=>error.message==='ADMIN_OPERATOR_REQUEST_INVALID');
});

test('transport forbids redirect, oversized or encoded response and bounds streamed bytes',async()=>{
  const bytes=encode(payload()),valid=request(bytes);let imported=false;
  for(const fetchImpl of [
    async()=>{throw new Error('presigned-credential-must-not-leak');},
    async()=>new Response(null,{status:302,headers:{location:'https://attacker.example'}}),
    async()=>new Response(bytes,{status:200,headers:{'content-length':'131073'}}),
    async()=>new Response(bytes,{status:200,headers:{'content-encoding':'gzip'}}),
    async()=>new Response(Buffer.alloc(131073)),
    async()=>({...response(bytes),status:200,redirected:true}),
  ])await rejectsSafe(executeAdminOperator(valid,{fetchImpl,importModule:async()=>{imported=true;}}));
  assert.equal(imported,false);
});

test('fetch has a fifteen-second default deadline and aborted requests produce only a fixed error',async()=>{
  const bytes=encode(payload());let observed,aborted=false;
  await rejectsSafe(executeAdminOperator(request(bytes),{
    timeoutMs:5,
    fetchImpl:async(_url,options)=>{observed=options;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('secret timeout details'));},{once:true}));},
  }));
  assert.equal(observed.redirect,'error');assert.equal(observed.headers['Accept-Encoding'],'identity');assert.equal(aborted,true);
  assert.match(executeAdminOperator.toString(),/timeoutMs\?\?15000/);
});

test('compressed SHA is checked before JSON parsing and decompression has a hard expansion bound',async()=>{
  const bytes=encode(payload());let imported=false;
  await rejectsSafe(executeAdminOperator({...request(bytes),bundleSha256:'0'.repeat(64)},{fetchImpl:async()=>response(bytes),importModule:async()=>{imported=true;}}));
  for(const invalid of [Buffer.from('not gzip'),encode('{invalid JSON'),encode(Buffer.from([0xff,0xfe])),encode('x'.repeat(524289))]){
    await rejectsSafe(executeAdminOperator(request(invalid),{fetchImpl:async()=>response(invalid),importModule:async()=>{imported=true;}}));
  }
  assert.equal(imported,false);
  const source=executeAdminOperator.toString();assert.ok(source.indexOf('sha(compressed)')<source.indexOf('JSON.parse'));
});

test('whole bundle is validated before import; duplicates, paths, extra fields and file corruption fail',async()=>{
  const invalids=[];
  for(const mutate of [
    b=>{b.files[0].name='../admin-dashboard-migration.mjs';},
    b=>{b.files[0].name='/tmp/admin-dashboard-migration.mjs';},
    b=>{b.files[1]=b.files[0];},
    b=>{b.files.pop();},
    b=>{b.files[2].content+=' altered';},
    b=>{b.files[2].sha256='0'.repeat(64);},
    b=>{b.files[2].mode=0o777;},
    b=>{b.extra='unreviewed';},
    b=>{b.files[2].content='\ud800';b.files[2].sha256=hash(b.files[2].content);},
  ]){const value=payload();mutate(value);invalids.push(encode(value));}
  let imported=false;
  for(const bytes of invalids)await rejectsSafe(executeAdminOperator(request(bytes),{fetchImpl:async()=>response(bytes),importModule:async()=>{imported=true;}}));
  assert.equal(imported,false);
});

test('exclusive private files are complete before main, SQL substitution is exact, and success cleans up',async()=>{
  const bytes=encode(payload());let directory,calls=0;
  await executeAdminOperator(request(bytes),{
    fetchImpl:async(seenUrl,options)=>{assert.equal(seenUrl,url);assert.equal(options.redirect,'error');return response(bytes);},
    importModule:async moduleUrl=>{
      const path=fileURLToPath(moduleUrl);directory=path.slice(0,path.lastIndexOf('/'));
      assert.match(directory,/^\/tmp\/packproof-admin-[A-Za-z0-9]+$/);assert.equal((await stat(directory)).mode&0o777,0o700);
      for(const file of payload().files){assert.equal(await readFile(`${directory}/${file.name}`,'utf8'),file.content);assert.equal((await stat(`${directory}/${file.name}`)).mode&0o777,0o600);}
      return{main:async args=>{calls++;assert.deepEqual(args,request(bytes).args.map(arg=>arg==='$RUNTIME_ROLES_SQL'?`${directory}/runtime-roles.sql`:arg));}};
    },
  });
  assert.equal(calls,1);await assert.rejects(stat(directory),{code:'ENOENT'});
  assert.match(executeAdminOperator.toString(),/flag:'wx'/);
});

test('import or main failures remove every temporary file and redact original exceptions',async()=>{
  const bytes=encode(payload());
  for(const failure of ['import','main']){
    let directory;
    await rejectsSafe(executeAdminOperator(request(bytes),{fetchImpl:async()=>response(bytes),importModule:async moduleUrl=>{
      directory=fileURLToPath(new URL('.',moduleUrl));
      if(failure==='import')throw new Error('database-password');
      return{main:async()=>{throw new Error('presigned-url-and-secret');}};
    }}));
    await assert.rejects(stat(directory),{code:'ENOENT'});
  }
});

test('migration composes only injected credentials, clears inherited callbacks and cleans on config failure',async()=>{
  const bytes=encode(payload()),keys=['PACKPROOF_DB_SECRET_ARN','PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN','PACKPROOF_ADMIN_MIGRATION_DATABASE_URL'];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let configCalls=0;
  try{
    process.env.PACKPROOF_DB_SECRET_ARN='inherited-runtime-secret';process.env.PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN='inherited-operator-secret';
    await executeAdminOperator(request(bytes,'admin-dashboard-migration.mjs'),{fetchImpl:async()=>response(bytes),importConfig:async()=>({loadConfig:env=>{
      configCalls++;assert.equal(env.PACKPROOF_DB_SECRET_ARN,'');return{databaseUrl:'postgresql://packproof:injected-only@db/packproof_v2'};
    }}),importModule:async()=>({main:async()=>{
      assert.equal(process.env.PACKPROOF_ADMIN_MIGRATION_DATABASE_URL,'postgresql://packproof:injected-only@db/packproof_v2');
      assert.equal(process.env.PACKPROOF_DB_SECRET_ARN,'');assert.equal(process.env.PACKPROOF_ADMIN_MIGRATION_DB_SECRET_ARN,'');
    }})});
    assert.equal(configCalls,1);
    await rejectsSafe(executeAdminOperator(request(bytes,'admin-dashboard-migration.mjs'),{fetchImpl:async()=>response(bytes),importConfig:async()=>({loadConfig:()=>({})})}));
  }finally{for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
});

test('generated ECS command stays below 8192 bytes with long signature and bounded operator environment',()=>{
  const bytes=encode(payload()),valid=request(bytes);valid.url+='&X-Amz-Security-Token='+encodeURIComponent('x+/='.repeat(200));
  const command=buildAdminOperatorCommand(valid);
  assert.deepEqual(command.slice(0,3),['node','--input-type=module','-e']);
  const override={containerOverrides:[{name:'packproof-api',command,environment:[{name:'PACKPROOF_ADMIN_MIGRATION_RECOVERY_POINT',value:'2026-09-24T12:00:00.000Z'},{name:'PACKPROOF_ADMIN_MIGRATION_RECOVERY_DB_ID',value:'packproof-v2-staging-db'}]}]};
  assert.ok(Buffer.byteLength(JSON.stringify(override))<8192);
  assert.throws(()=>buildAdminOperatorCommand({...valid,url:url+'&token='+'x'.repeat(3700)}),/COMMAND_TOO_LARGE|REQUEST_INVALID/);
});

test('generated source runs independently, imports only chosen operator and emits fixed failure output',()=>{
  const bundle=payload();bundle.files[1].content='export async function main(args){console.log(JSON.stringify({mode:args[0],sql:args[4].endsWith("/runtime-roles.sql")}));}';bundle.files[1].sha256=hash(bundle.files[1].content);
  const bytes=encode(bundle),command=buildAdminOperatorCommand(request(bytes));
  const success=spawnSync(process.execPath,[...command.slice(1,3),`globalThis.fetch=async()=>new Response(Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));\n${command[3]}`],{encoding:'utf8'});
  assert.equal(success.status,0,success.stderr);assert.deepEqual(JSON.parse(success.stdout),{mode:'--inspect',sql:true});assert.equal(success.stderr,'');
  const failure=spawnSync(process.execPath,[...command.slice(1,3),`globalThis.fetch=async()=>{throw new Error('secret-presigned-query');};\n${command[3]}`],{encoding:'utf8'});
  assert.equal(failure.status,1);assert.equal(failure.stderr,'');assert.deepEqual(JSON.parse(failure.stdout),{event:'admin_operator_failed',code:'ADMIN_OPERATOR_FAILED'});
});
