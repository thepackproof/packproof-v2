import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {validateReaderReview,validateReaderTask,verifyReaderDatabase} from './shipment-rollback-reader-probe.mjs';

const review={kind:'api',sourceSha:'a'.repeat(40),image:'123456789012.dkr.ecr.us-east-1.amazonaws.com/backend@sha256:'+'1'.repeat(64),
  environment:'staging',clusterArn:'arn:aws:ecs:us-east-1:123456789012:cluster/test',database:{name:'test',host:'test.example.invalid'},
  apiRole:'reader_api',workerRole:'reader_worker',inventorySha256:'3a0d0f641856846529659e12eb7ba166f8542753b663b4d5ab903862ee905de5',reviewSha256:'c'.repeat(64)};
const env={PACKPROOF_RELEASE_SHA:review.sourceSha,PACKPROOF_RELEASE_IMAGE:review.image,PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_PROCESS_ROLE:'api',PACKPROOF_ENVIRONMENT:'staging'};
const container={Image:review.image,ImageID:review.image.split('@')[1]};
const task={Cluster:'test',TaskARN:review.clusterArn.replace(':cluster/',':task/')+'/'+'7'.repeat(32)};
const root=new URL('../../backend/migrations/',import.meta.url);
const names=(await readdir(root)).filter(name=>name.endsWith('.sql')).sort();
const applied=await Promise.all(names.map(async name=>({id:name.slice(0,-4),checksum:createHash('sha256').update(await readFile(new URL(name,root))).digest('hex')})));
const ddl=await readFile(new URL('121_shipment_interpretation_decisions.sql',root),'utf8');
const prosrc=ddl.match(/LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/)[1];

test('binds the predecessor process, image, cluster, task and both independent logins',()=>{
  assert.equal(validateReaderReview(review,env),'reader_api');
  assert.equal(validateReaderReview({...review,kind:'worker'},{...env,PACKPROOF_PROCESS_ROLE:'worker'}),'reader_worker');
  assert.throws(()=>validateReaderReview({...review,workerRole:review.apiRole},env),/REVIEW_INVALID/);
  assert.throws(()=>validateReaderReview(review,{...env,PACKPROOF_MIGRATE_ON_START:'true'}),/RUNTIME_BINDING/);
  assert.throws(()=>validateReaderReview({...review,inventorySha256:'0'.repeat(64)},env),/REVIEW_INVALID/);
  validateReaderTask(review,container,task);
  for(const [c,t] of [[{...container,ImageID:'sha256:'+'2'.repeat(64)},task],[container,{...task,Cluster:'other'}],[container,{...task,TaskARN:task.TaskARN+'0'}]]){
    assert.throws(()=>validateReaderTask(review,c,t),/ACTUAL_TASK/);
  }
});

function fixture(options={}) {
  const identity={role:'reader_api',login:'reader_api',database:'test',schema:'public',ro:'on',tls:true,...options.identity};
  const calls=[];
  const db={async query(sql){
    calls.push(sql);
    if(sql.startsWith('SET '))return {rows:[]};
    if(sql.includes('pg_stat_ssl'))return {rows:[identity]};
    if(sql.includes('ORDER BY id')&&sql.includes('schema_migrations'))return {rows:options.applied??applied};
    if(sql.includes('FROM pg_roles'))return {rows:[{unsafe:options.unsafe??false}]};
    if(sql.includes('FROM pg_trigger'))return {rows:options.guard??[{prosrc}]};
    assert.match(sql,/FROM public.partner_import_jobs ORDER BY id LIMIT 32/);
    assert.match(sql,/public.partner_import_rows/);
    return {rows:options.receipt??[{readable:true}]};
  }};
  return {db,calls};
}
test('reads the legacy receipt shape, counts an empty sample honestly and calls the actual startup guard',async()=>{
  for(const [receipt,observed] of [[[],false],[[{readable:true}],true]]){
    const {db,calls}=fixture({receipt});let guardCalls=0;
    assert.deepEqual(await verifyReaderDatabase(db,review,'reader_api',async tx=>{assert.equal(tx,db);guardCalls++;}),{legacyReceiptObserved:observed});
    assert.equal(guardCalls,1);assert.match(calls[0],/REPEATABLE READ READ ONLY/);
  }
});
test('wrong role, TLS, migration bytes, unsafe authority, mutable decision, invalid receipt or an incompatible predecessor fail closed',async()=>{
  for(const [options,code] of [[{identity:{login:'owner'}},'ACTUAL_LOGIN'],[{identity:{tls:false}},'ACTUAL_LOGIN'],
    [{applied:applied.slice(1)},'APPLIED_INVENTORY'],[{applied:applied.map((r,i)=>i?r:{...r,checksum:review.reviewSha256})},'APPLIED_INVENTORY'],
    [{unsafe:true},'UNSAFE_AUTHORITY'],[{guard:[]},'IMMUTABILITY_GUARD'],[{guard:[{prosrc:prosrc+' '}]},'IMMUTABILITY_GUARD'],
    [{receipt:[{readable:false}]},'LEGACY_RECEIPT']]){
    await assert.rejects(verifyReaderDatabase(fixture(options).db,review,'reader_api',async()=>{}),new RegExp(code));
  }
  await assert.rejects(verifyReaderDatabase(fixture().db,review,'reader_api',async()=>{throw Error('private details');}),/ROLLBACK_READER_SCHEMA_NOT_ADMITTED/);
});
test('the compressed standalone command runs as a data module and redacts invalid input',async()=>{
  const code=await readFile(new URL('./shipment-rollback-reader-probe.mjs',import.meta.url));
  const command=`const data=(await import('node:zlib')).gunzipSync(Buffer.from('${gzipSync(code).toString('base64')}','base64'));await (await import('data:text/javascript;base64,'+data.toString('base64'))).runRollbackReaderProbe();`;
  assert.ok(Buffer.byteLength(JSON.stringify(['node','--input-type=module','-e',command,'probe',JSON.stringify(review)]))<7800);
  const result=spawnSync(process.execPath,['--input-type=module','-e',command,'probe','PRIVATE_INPUT'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr),{event:'shipment_rollback_reader_failed',code:'ROLLBACK_READER_FAILED'});
});
