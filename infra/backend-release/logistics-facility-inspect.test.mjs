import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {brotliCompressSync,brotliDecompressSync} from 'node:zlib';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {inspectionInput,inspectFacilities,runFacilityInspection,facilityEnvelopeHeader,decryptFacilityReceipt} from './logistics-facility-inspect.mjs';
import {verifierTaskDefinition} from './backend-release-requests.mjs';

const source='a'.repeat(40),inventory='8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
const {ledger}=JSON.parse(await readFile(new URL('./logistics-facility-inspect.fixture.json',import.meta.url),'utf8'));
const recoveryInventory='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
const recoverySql=await readFile(new URL('../../backend/migrations/130_connect_recovery_collector_version.sql',import.meta.url));
const recoveryLedger=[...ledger,{id:'130_connect_recovery_collector_version',checksum:createHash('sha256').update(recoverySql).digest('hex')}];
const subject='11111111-2222-4333-8444-555555555555',user='user_01TESTONLY';
const subjectSha256=createHash('sha256').update(subject).digest('hex');
const recipient=generateKeyPairSync('x25519');
const recipientPublicKeySpki=recipient.publicKey.export({type:'spki',format:'der'}).toString('base64');
const privateKey=recipient.privateKey.export({type:'pkcs8',format:'pem'});
const repository='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api';
const image=repository+'@sha256:'+'b'.repeat(64),digest=image.split('@')[1];
const task='arn:aws:ecs:us-east-1:784514617543:task/packproof-v2-staging-cluster/'+'c'.repeat(32);
const environment=()=>({PACKPROOF_RELEASE_SHA:source,PACKPROOF_RELEASE_IMAGE:image,
  PACKPROOF_ENVIRONMENT:'production',PACKPROOF_PROCESS_ROLE:'api',PACKPROOF_MIGRATE_ON_START:'false',
  PACKPROOF_DB_HOST:'packproof-v2-staging-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',PACKPROOF_DB_NAME:'packproof_v2',
  PACKPROOF_DB_USER:'packproof_records_api_v1',PACKPROOF_DB_PASSWORD:'DO_NOT_EMIT',
  PACKPROOF_DB_CA_FILE:'/app/backend/certs/rds-us-east-1-bundle.pem',
  ECS_CONTAINER_METADATA_URI_V4:'http://169.254.170.2/v4/test_container'});
const databaseIdentity=()=>({role:'packproof_records_api_v1',login:'packproof_records_api_v1',database:'packproof_v2',
  read_only:'on',ssl:true,unprivileged:true});
const installation=(id='installation_example')=>({installation_id:id,organization_id:'organization_example',
  organization_name:'Example organization',environment:'sandbox',location_id:'location_example',location_name:'Example location',
  device_name:'Example workstation',version:'0.7.0',status:'ready',last_seen_at:null,updated_at:'2026-11-21T12:00:00Z',
  organization_enabled:true,actor_membership_id:'membership_example',actor_role:'OWNER',enrollment_acknowledged:true,
  renewal_pending:false,location_exists:true,actor_location_allowed:true,approved_by_actor:true,assigned_to_actor:true,
  total_matching_installations:'1'});
function connection(options={}) {
  const calls=[];let ended=false;
  return {calls,get ended(){return ended;},async end(){ended=true;},async query(sql,params){
    calls.push({sql,params});
    if(options.failAt && sql.includes(options.failAt)) throw Error('DO_NOT_EMIT_DATABASE_ERROR');
    if(sql.includes('FROM pg_roles')) return {rows:[options.who??databaseIdentity()]};
    if(sql.includes('public.schema_migrations')) return {rows:options.ledger??ledger};
    if(sql.includes('public.auth_identities')) return {rows:options.users??[{user_id:user,status:'ACTIVE',service_principal:false}]};
    if(sql.includes('eligible_location_id')) return {rows:options.locations??[]};
    if(sql.includes('public.record_agent_installations')) return {rows:options.installations??[installation()]};
    assert.match(sql,/^(BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL (statement_timeout='5s'|lock_timeout='2s'|idle_in_transaction_session_timeout='10s')|ROLLBACK)$/);
    return {rows:[]};
  }};
}
function requests(change={}) {
  return async(url,options)=>{
    assert.ok(['http://169.254.170.2/v4/test_container','http://169.254.170.2/v4/test_container/task'].includes(url));
    assert.equal(options.redirect,'error');assert.ok(options.signal);
    return {ok:true,json:async()=>url.endsWith('/task')?{TaskARN:change.task??task}:{Image:change.image??image,ImageID:change.digest??digest}};
  };
}

test('requires exact trusted subject and reviewed source/image/runtime; no free SQL or target input',()=>{
  assert.deepEqual(inspectionInput([source,inventory,subject],environment()),{source,inventory,subject,image});
  assert.equal(inspectionInput([source,inventory,subject],{...environment(),PACKPROOF_DB_CA_FILE:'/app/certs/rds-us-east-1-bundle.pem'}).image,image);
  assert.equal(inspectionInput([source,inventory,'11111111-2222-70e5-d3c9-333333333333'],environment()).image,image);
  assert.equal(inspectionInput([source,recoveryInventory,subject],environment()).inventory,recoveryInventory);
  for(const args of [[source,inventory,'person@example.invalid'],[source,inventory,subject+'\n'],
    [source,inventory,"x'; SELECT * FROM platform_credentials;--"],[source,inventory,subject,'SELECT 1'],
    [source,'0'.repeat(64),subject],['main',inventory,subject]]) {
    assert.throws(()=>inspectionInput(args,environment()),/FACILITY_INSPECT_ARGUMENTS/);
  }
  for(const overrides of [
    {PACKPROOF_RELEASE_SHA:'d'.repeat(40)},{PACKPROOF_RELEASE_IMAGE:repository+':latest'},
    {PACKPROOF_PROCESS_ROLE:'worker'},{PACKPROOF_DB_USER:'packproof'},{PACKPROOF_MIGRATE_ON_START:'true'},
    {PACKPROOF_DB_HOST:'other.example.invalid'},{PACKPROOF_DB_NAME:'other'},{PACKPROOF_DB_PORT:'5433'},
    {PACKPROOF_DB_SSLMODE:'disable'},{PACKPROOF_DB_CA_FILE:'/tmp/unreviewed.pem'},
    {PACKPROOF_DB_PASSWORD:''},{ECS_CONTAINER_METADATA_URI_V4:'https://other.example.invalid'}
  ]) assert.throws(()=>inspectionInput([source,inventory,subject],{...environment(),...overrides}),/FACILITY_INSPECT_/);
});

test('metadata mismatch cannot reach the database',async()=>{
  for(const change of [{image:repository+':latest'},{digest:'sha256:'+'d'.repeat(64)},
    {task:task.replace('784514617543','111111111111')},{task:task+'extra'}]) {
    await assert.rejects(runFacilityInspection({args:[source,inventory,subject],env:environment(),request:requests(change),
      open:()=>assert.fail('Database must not open')}),/FACILITY_INSPECT_TASK_IMAGE_CLUSTER/);
  }
});

test('only subject identity and current scoped admin metadata are queried; output is allowlisted and rollback precedes result',async()=>{
  const row={...installation(),renewal_response:'DO_NOT_EMIT',credential_id:'DO_NOT_EMIT',approved_config:{original:'DO_NOT_EMIT'}};
  const client=connection({installations:[row]});
  const receipt=await runFacilityInspection({args:[source,inventory,subject],env:environment(),request:requests(),open:async()=>client});
  assert.equal(client.calls[0].sql,'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.calls.at(-1).sql,'ROLLBACK');assert.equal(client.ended,true);
  assert.match(client.calls.find(c=>c.sql.includes('FROM pg_roles')).sql,/NOT\(r\.rolsuper OR r\.rolbypassrls OR r\.rolcreaterole OR r\.rolcreatedb\) AS unprivileged/);
  const lookup=client.calls.find(c=>c.sql.includes('public.auth_identities'));
  assert.deepEqual(lookup.params,[subject]);assert.match(lookup.sql,/ai\.provider='cognito' AND ai\.provider_subject=\$1 LIMIT 2/);
  const facilities=client.calls.find(c=>c.sql.includes('public.record_agent_installations'));
  assert.deepEqual(facilities.params,[user]);
  assert.match(facilities.sql,/m\.user_id=\$1 AND m\.revoked_at IS NULL AND m\.role IN \('OWNER','ADMIN'\)/);
  assert.match(facilities.sql,/i\.organization_id=o\.id AND i\.environment=o\.environment/);
  assert.match(facilities.sql,/g\.organization_id=i\.organization_id AND g\.location_id=i\.location_id AND g\.membership_id=m\.id/);
  assert.match(facilities.sql,/LIMIT 21$/);
  assert.equal(receipt.userId,user);assert.equal(receipt.readOnly,true);assert.equal(receipt.rolledBack,true);
  assert.equal(receipt.image,image);assert.equal(receipt.actualTask,task);assert.equal(receipt.installations.length,1);
  assert.equal(receipt.truncated,false);assert.equal(receipt.totalMatchingInstallations,1);
  const choices=client.calls.find(c=>c.sql.includes('eligible_location_id'));
  assert.deepEqual(choices.params,[user,row.installation_id,row.organization_id,row.environment]);
  assert.match(choices.sql,/actor\.user_id=\$1/);
  assert.match(choices.sql,/operator\.id=i\.operator_membership_id AND operator\.organization_id=o\.id/);
  assert.match(choices.sql,/operator\.revoked_at IS NULL AND operator\.role IN \('OWNER','ADMIN','OPERATOR'\)/);
  assert.match(choices.sql,/teammate\.id=operator\.user_id AND teammate\.status='ACTIVE'/);
  assert.match(choices.sql,/g\.organization_id=o\.id AND g\.location_id=l\.id AND g\.membership_id=actor\.id/);
  assert.match(choices.sql,/g\.organization_id=o\.id AND g\.location_id=l\.id AND g\.membership_id=operator\.id/);
  assert.match(choices.sql,/i\.id=\$2 AND i\.organization_id=\$3 AND i\.environment=\$4/);
  assert.match(choices.sql,/LIMIT 21$/);
  assert.doesNotMatch(JSON.stringify(receipt),/DO_NOT_EMIT|renewal_response|credential_id|approved_config|11111111-2222/);
  assert.ok(client.calls.every(c=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|COMMIT)\b/i.test(c.sql)));
});

test('owner/elevated/wrong database and non-read-only connections fail before identity lookup',async()=>{
  for(const overrides of [{role:'packproof'},{login:'packproof'},{database:'other'},{read_only:'off'},
    {ssl:false},{unprivileged:false}]) {
    const client=connection({who:{...databaseIdentity(),...overrides}});
    await assert.rejects(inspectFacilities(client,subject,inventory),/FACILITY_INSPECT_DATABASE_IDENTITY/);
    assert.equal(client.calls.at(-1).sql,'ROLLBACK');
    assert.ok(!client.calls.some(c=>c.sql.includes('public.auth_identities')));
  }
});

test('missing, duplicate, inactive or service identities cannot enumerate installations',async()=>{
  for(const users of [[],[{user_id:user,status:'ACTIVE',service_principal:false},{user_id:user,status:'ACTIVE',service_principal:false}],
    [{user_id:user,status:'DISABLED',service_principal:false}],[{user_id:user,status:'ACTIVE',service_principal:true}]]) {
    const client=connection({users});
    await assert.rejects(inspectFacilities(client,subject,inventory),/FACILITY_INSPECT_UNIQUE_ACTIVE_HUMAN/);
    assert.equal(client.calls.at(-1).sql,'ROLLBACK');
    assert.ok(!client.calls.some(c=>c.sql.includes('public.record_agent_installations')));
  }
});

test('bounded result reports truncation and rejects inconsistent/duplicate inventory',async()=>{
  const rows=Array.from({length:21},(_,i)=>({...installation('installation_'+i),total_matching_installations:'25'}));
  const receipt=await inspectFacilities(connection({installations:rows}),subject,inventory);
  assert.equal(receipt.installations.length,21);assert.equal(receipt.totalMatchingInstallations,25);assert.equal(receipt.truncated,true);
  for(const bad of [[installation(),installation()],rows.map((row,i)=>i?row:{...row,total_matching_installations:'not-a-number'})]) {
    await assert.rejects(inspectFacilities(connection({installations:bad}),subject,inventory),/FACILITY_INSPECT_INVENTORY_SHAPE/);
  }
  assert.deepEqual(await inspectFacilities(connection({installations:[]}),subject,inventory),
    {userId:user,totalMatchingInstallations:0,truncated:false,installations:[]});
});

test('observes the real pinned ledger; missing, changed, reordered and extra migration rows fail before identity lookup',async()=>{
  const previous='d0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60';
  const old=await inspectFacilities(connection({ledger:ledger.slice(0,123)}),subject,previous);
  assert.equal(old.userId,user);
  const changed=structuredClone(ledger);changed[0].checksum='0'.repeat(64);
  for(const rows of [ledger.slice(0,-1),changed,ledger.toReversed(),[...ledger,{id:'130_unreviewed',checksum:'0'.repeat(64)}]]) {
    const client=connection({ledger:rows});
    await assert.rejects(inspectFacilities(client,subject,inventory),/FACILITY_INSPECT_LEDGER/);
    assert.equal(client.calls.at(-1).sql,'ROLLBACK');
    assert.ok(!client.calls.some(c=>c.sql.includes('public.auth_identities')));
  }
  const current=connection({ledger:recoveryLedger});
  assert.equal((await inspectFacilities(current,subject,recoveryInventory)).userId,user);
  assert.match(current.calls.find(c=>c.sql.includes('public.schema_migrations')).sql,/LIMIT 130$/);
  for(const rows of [ledger,[...recoveryLedger,{id:'131_unreviewed',checksum:'0'.repeat(64)}]]) {
    const client=connection({ledger:rows});
    await assert.rejects(inspectFacilities(client,subject,recoveryInventory),/FACILITY_INSPECT_LEDGER/);
    assert.ok(!client.calls.some(c=>c.sql.includes('public.auth_identities')));
  }
});

test('guided and assistant status uses only the actual exact workspace allowlists and never exposes them',async()=>{
  const location=(id,name)=>({eligible_location_id:id,location_name:name,total_eligible_locations:'2'});
  const locations=[location('location_example','Example'),location('location_other','Other')];
  const flags={PACKPROOF_ORDER_WORKSPACE_ENABLED:'true',
    PACKPROOF_GUIDED_FACILITIES:'foreign:live:DO_NOT_EMIT, organization_example:sandbox:location_example ',
    PACKPROOF_SETUP_AI_FACILITIES:'organization_example:sandbox:location_other,organization_example:sandbox:location_example'};
  const run=env=>inspectFacilities(connection({locations}),subject,inventory,env);
  const receipt=await run(flags),installation=receipt.installations[0];
  assert.equal(installation.guidedSetupAvailable,true);assert.equal(installation.assistantSetupAvailable,true);
  assert.deepEqual(installation.eligibleLocations,[{id:'location_example',name:'Example',guidedSetupAvailable:true,assistantSetupAvailable:true},
    {id:'location_other',name:'Other',guidedSetupAvailable:false,assistantSetupAvailable:false}]);
  assert.equal(installation.totalEligibleLocations,2);assert.equal(installation.eligibleLocationsTruncated,false);
  assert.doesNotMatch(JSON.stringify(receipt),/DO_NOT_EMIT|PACKPROOF_GUIDED|PACKPROOF_SETUP_AI/);
  for(const changed of [{PACKPROOF_ORDER_WORKSPACE_ENABLED:'false'},{PACKPROOF_ORDER_WORKSPACE_ENABLED:'TRUE'},
    {PACKPROOF_GUIDED_FACILITIES:'organization_example:live:location_example'},{PACKPROOF_GUIDED_FACILITIES:'other:sandbox:location_example'}])
    assert.ok((await run({...flags,...changed})).installations[0].eligibleLocations.every(row=>!row.guidedSetupAvailable&&!row.assistantSetupAvailable));
  const guidedOnly=(await run({...flags,PACKPROOF_SETUP_AI_FACILITIES:''})).installations[0].eligibleLocations[0];
  assert.equal(guidedOnly.guidedSetupAvailable,true);assert.equal(guidedOnly.assistantSetupAvailable,false);
});

test('eligible choices are bounded, explicit about truncation and reject inconsistent or duplicate rows',async()=>{
  const locations=Array.from({length:21},(_,i)=>({eligible_location_id:'location_'+i,location_name:'Location '+i,total_eligible_locations:'40'}));
  const output=(await inspectFacilities(connection({locations}),subject,inventory)).installations[0];
  assert.equal(output.eligibleLocations.length,21);assert.equal(output.totalEligibleLocations,40);assert.equal(output.eligibleLocationsTruncated,true);
  for(const rows of [[locations[0],locations[0]],locations.map((row,i)=>i?row:{...row,total_eligible_locations:'no'}),
    [...locations,{...locations[0],eligible_location_id:'location_extra'}]]) {
    const client=connection({locations:rows});
    await assert.rejects(inspectFacilities(client,subject,inventory),/FACILITY_INSPECT_LOCATIONS_SHAPE/);
    assert.equal(client.calls.at(-1).sql,'ROLLBACK');
  }
});

test('query and rollback failures close the connection and cannot emit success',async()=>{
  for(const failAt of ['public.record_agent_installations','ROLLBACK']) {
    const client=connection({failAt});
    await assert.rejects(runFacilityInspection({args:[source,inventory,subject],env:environment(),request:requests(),open:async()=>client}),/DO_NOT_EMIT_DATABASE_ERROR/);
    assert.equal(client.calls.at(-1).sql,'ROLLBACK');assert.equal(client.ended,true);
  }
});

test('workflow mode looks up only the exact verified subject digest and emits encrypted account metadata',async()=>{
  const client=connection();
  const envelope=await runFacilityInspection({args:[source,inventory,subjectSha256,recipientPublicKeySpki],env:environment(),request:requests(),open:async()=>client});
  const lookup=client.calls.find(c=>c.sql.includes('public.auth_identities'));
  assert.deepEqual(lookup.params,[subjectSha256]);
  assert.match(lookup.sql,/encode\(sha256\(convert_to\(ai\.provider_subject,'UTF8'\)\),'hex'\)=\$1/);
  assert.ok(!JSON.stringify(client.calls).includes(subject));
  const report=decryptFacilityReceipt(envelope,privateKey,{source,image,inventorySha256:inventory,actualTask:task,subjectSha256});
  assert.equal(report.userId,user);assert.equal(report.installations[0].device_name,'Example workstation');
  const encoded=JSON.stringify(envelope),header=facilityEnvelopeHeader(envelope);
  assert.doesNotMatch(encoded,/user_01TESTONLY|installation_example|organization_example|Example workstation|DO_NOT_EMIT/);
  assert.doesNotMatch(JSON.stringify(header),/user_|organization_|location_|installation_/);
  assert.equal(header.subjectSha256,subjectSha256);
  const missing=connection({users:[]});
  await assert.rejects(runFacilityInspection({args:[source,inventory,'0'.repeat(64),recipientPublicKeySpki],env:environment(),request:requests(),open:async()=>missing}),/UNIQUE_ACTIVE_HUMAN/);
  assert.equal(missing.calls.at(-1).sql,'ROLLBACK');
});

test('encrypted receipt authentication rejects tampering, another recipient and every source/task/subject binding mismatch',async()=>{
  const envelope=await runFacilityInspection({args:[source,inventory,subjectSha256,recipientPublicKeySpki],env:environment(),request:requests(),open:async()=>connection()});
  const expected={source,image,inventorySha256:inventory,actualTask:task,subjectSha256};
  const second=generateKeyPairSync('x25519').privateKey.export({type:'pkcs8',format:'pem'});
  assert.throws(()=>decryptFacilityReceipt(envelope,second,expected),/RECIPIENT_KEY/);
  for(const name of Object.keys(expected))assert.throws(()=>decryptFacilityReceipt(envelope,privateKey,{...expected,[name]:'changed'}),/ENVELOPE_BINDING/);
  for(const name of ['ciphertext','tag']) {
    const changed=structuredClone(envelope),bytes=Buffer.from(changed[name],'base64');bytes[0]^=1;changed[name]=bytes.toString('base64');
    assert.throws(()=>decryptFacilityReceipt(changed,privateKey,expected));
  }
  const changed=structuredClone(envelope),header=facilityEnvelopeHeader(changed);
  header.completedAt='2026-11-23T00:00:00Z';changed.protected=Buffer.from(JSON.stringify(header)).toString('base64');
  assert.throws(()=>decryptFacilityReceipt(changed,privateKey,expected));
  const swapped=structuredClone(envelope),swappedHeader=facilityEnvelopeHeader(swapped);
  swappedHeader.actualTask=task.replace(/c{32}$/,'d'.repeat(32));swapped.protected=Buffer.from(JSON.stringify(swappedHeader)).toString('base64');
  assert.throws(()=>decryptFacilityReceipt(swapped,privateKey,{...expected,actualTask:swappedHeader.actualTask}));
  assert.throws(()=>decryptFacilityReceipt({...envelope,plaintext:'unreviewed'},privateKey,expected),/ENVELOPE_SHAPE/);
});

test('the exact compressed module preserves inspection and fits the unchanged one-shot command limit',async()=>{
  const text=await readFile(new URL('./logistics-facility-inspect.mjs',import.meta.url),'utf8');
  const compressed=brotliCompressSync(Buffer.from(text)).toString('base64');
  assert.equal(brotliDecompressSync(Buffer.from(compressed,'base64')).toString(),text);
  const module=await import('data:text/javascript;base64,'+brotliDecompressSync(Buffer.from(compressed,'base64')).toString('base64'));
  const checkRun=async(fn)=>{
    const receipt=await fn({args:[source,inventory,subject],env:environment(),request:requests(),open:async()=>connection()});
    delete receipt.completedAt;return receipt;
  };
  assert.deepEqual(await checkRun(module.runFacilityInspection),await checkRun(runFacilityInspection));
  const env={...environment(),PACKPROOF_RELEASE_VERSION:'test-only'};delete env.PACKPROOF_DB_PASSWORD;
  const taskDefinition={family:'api-test',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],
    taskRoleArn:'arn:aws:iam::784514617543:role/runtime',executionRoleArn:'arn:aws:iam::784514617543:role/execute',
    containerDefinitions:[{name:'api',image,environment:Object.entries(env).map(([name,value])=>({name,value})),
      logConfiguration:{logDriver:'awslogs',options:{'awslogs-group':'/test','awslogs-stream-prefix':'test','awslogs-region':'us-east-1'}}}]};
  const script='process.argv.push('+JSON.stringify(subjectSha256)+','+JSON.stringify(recipientPublicKeySpki)+');\n'+
    "const {brotliDecompressSync}=await import('node:zlib');const inspector=await import('data:text/javascript;base64,'+brotliDecompressSync(Buffer.from("+
    JSON.stringify(compressed)+",'base64')).toString('base64'));await inspector.facilityInspectionMain();";
  const prepared=verifierTaskDefinition(taskDefinition,{sourceSha:source,image,version:'test-only',script,inventorySha256:inventory,runId:'1'});
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.request.containerDefinitions[0].command))<7800);
});
