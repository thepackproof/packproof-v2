// Runs in the pinned foundation bridge image against a newly created Docker
// PostgreSQL fixture. Never uses a production hostname, key or credential.
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPgDatabase} from '../dist/db/postgres.js';
import {migrate,assertSchemaCurrent,migrationInventory} from '../dist/db/migrate.js';
import {splitSqlStatements} from '../dist/db/sql.js';
import {M2_BRIDGE_PARENT,M2_BRIDGE_MIGRATIONS} from '../dist/db/m2-inactive-bridge.js';
import {insertUser} from '../dist/domain/users.js';
import {createTransaction} from '../dist/domain/transactions.js';
import {createOrGetProof} from '../dist/domain/create-proof.js';
import {commitAttestation} from '../dist/domain/attestations.js';
import {finalizeProof} from '../dist/domain/finalize.js';
import {createSignatureSnapshot,buildSignatureCase} from '../dist/domain/signature.js';
import {queueRecipientExport,processRecipientExport,getRecipientExport,approveRecipientExport,readRecipientExportFile,downloadRecipientExport} from '../dist/domain/recipient-exports.js';
import {RECIPIENT_PROFILES} from '../dist/export/recipient-profiles.js';
import {LocalObjectStore} from '../dist/s3/local-object-store.js';
import {loadManifestSigningRuntime} from '../dist/integrity/signing-runtime.js';
import {verifyManifestIntegrity} from '../dist/domain/manifest-signing.js';
import {createServerApp} from '../dist/server-app.js';
import {BearerUserAdapter} from '../dist/auth/adapter.js';
import {MemoryCredentialStore} from '../dist/integrations/memory-credential-store.js';
import {createDefaultIntegrationRegistry} from '../dist/integrations/registry.js';

assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m2-bridge-compatibility');
assert.equal(M2_BRIDGE_PARENT,'99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9');
const image='784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-v2-staging-api@sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54';
assert.equal(process.env.M2_IMAGE,image);assert.match(process.env.M2_HARNESS_SHA??'',/^[a-f0-9]{40}$/);
const mode=process.env.M2_MODE;assert.ok(['bootstrap','before','migrate','after'].includes(mode));
const source='399f306a2fdac37511c8659c73d5a059dd759b7a',directory='/fixture';
const host='m2-bridge-postgres',database='m2_bridge',runtime='m2_bridge_runtime';
const hash=x=>createHash('sha256').update(x).digest('hex');
// The released profiles are historical. A fixed synthetic clock tests their
// original contract without representing them as currently reviewed providers.
const clock={now:()=>new Date('2026-09-07T12:00:00.000Z')};
const store=new LocalObjectStore(directory+'/objects','http://127.0.0.1','synthetic-local-storage');
const read=name=>readFile(directory+'/'+name,'utf8').then(JSON.parse);
const save=(name,value)=>writeFile(directory+'/'+name,JSON.stringify(value),{mode:0o600});
const connect=(user,password)=>{assert.match(password,/^[A-Za-z0-9_-]{32,100}$/);return createPgDatabase(`postgres://${user}:${password}@${host}:5432/${database}?sslmode=disable`);};
const report={event:'m2_bridge_compiled_acceptance',schema:'packproof.m2-bridge-compiled-acceptance.v1',mode,source,harness:process.env.M2_HARNESS_SHA,image,syntheticOnly:true,productionChanged:false,actualDevice:false,humanReview:false,productionAuthentication:false,cloudObjectLock:false,providerSubmission:false,fixtureClock:clock.now().toISOString(),checks:[]};
const check=name=>report.checks.push(name);
let opened,server,phase='configuration';
async function frozen(db){
 const result={};for(const table of ['final_manifests','evidence','signature_snapshots','signature_cases','recipient_export_jobs','recipient_export_approvals']){
  const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  result[table]={count:rows.length,sha256:hash(JSON.stringify(rows))};
 }return result;
}
try{
 if(mode==='bootstrap'||mode==='migrate'){
  assert.ok(process.env.M2_FIXTURE_OWNER_PASSWORD);opened=connect('fixture_owner',process.env.M2_FIXTURE_OWNER_PASSWORD);
 }else{
  assert.equal(process.env.M2_FIXTURE_OWNER_PASSWORD,undefined);
  const credentials=await read('runtime-credentials.json');assert.equal(credentials.username,runtime);
  opened=connect(credentials.username,credentials.password);
 }
 const db=opened.db;phase='database';
 const identity=(await db.query('SELECT current_user AS principal,session_user AS login,current_database() AS database')).rows[0];
 assert.equal(identity.database,database);assert.equal(identity.login,mode==='bootstrap'||mode==='migrate'?'fixture_owner':runtime);assert.equal(identity.principal,identity.login);report.databaseIdentity=identity;
 if(mode==='bootstrap'){
  await mkdir(directory,{recursive:true});await migrate(db);assert.equal((await migrationInventory()).length,91);
  const password=randomBytes(32).toString('base64url');await db.query("SET password_encryption='scram-sha-256'");
  await db.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await db.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);await db.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${runtime}`);
  await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
  await db.query(`REVOKE ALL ON schema_migrations FROM ${runtime}`);await db.query(`GRANT SELECT ON schema_migrations TO ${runtime}`);
  await save('runtime-credentials.json',{username:runtime,password});check('separate_non_owner_runtime_created_before_m2_tables');
  phase='synthetic_fixture';
  const actor=await insertUser(db,clock),other=await insertUser(db,clock);
  const transaction=await createTransaction(db,clock,actor,{itemTitle:'Synthetic historical bridge fixture',quantity:1});
  const proof=await createOrGetProof(db,clock,actor,transaction.transactionId);
  const file=directory+'/synthetic-video.mp4';await promisify(execFile)('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=25','-t','0.4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file],{timeout:20000});
  const bytes=await readFile(file),evidenceId='evd_synthetic_m2_bridge',staging=`evidence/${proof.proofId}/${evidenceId}/object`;
  await store.put(staging,bytes,'video/mp4');const original=await store.commitUpload(staging,{sha256:hash(bytes),byteSize:bytes.length,contentType:'video/mp4'});assert.ok(original?.versionId);
  const at=clock.now().toISOString();
  await db.query("INSERT INTO evidence(id,proof_id,submitted_by,object_key,object_version_id,staging_version_id,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin) VALUES($1,$2,$3,$4,$5,$6,'video/mp4',$7,$8,$9,$9,'COMMITTED','FULFILLMENT_CAPTURE','LEGACY_UNKNOWN')",[evidenceId,proof.proofId,actor,original.key,original.versionId,original.stagingVersionId,original.byteSize,original.sha256,at]);
  await commitAttestation(db,clock,actor,proof.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidenceId});
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  await writeFile(directory+'/signing-key.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  await save('trust.json',{schema:'packproof.trust-list.v1',generatedAt:'2026-09-07T00:00:00Z',expiresAt:'2026-09-14T00:00:00Z',keys:[{keyId:'synthetic-bridge-key',algorithm:'ECDSA_SHA_256',publicKeyPem,status:'ACTIVE'}]});
  const signing=loadManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'pem',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_SIGNING_KEY_FILE:directory+'/signing-key.pem',PACKPROOF_MANIFEST_SIGNING_KEY_ID:'synthetic-bridge-key',PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256',PACKPROOF_MANIFEST_TRUST_LIST_FILE:directory+'/trust.json'});
  const finalized=await finalizeProof(db,clock,actor,proof.proofId,signing.signer);
  await rm(directory+'/signing-key.pem');
  await save('fixture.json',{actor,other,proofId:proof.proofId,evidenceId,original,manifestSha256:finalized.manifest.sha256,publicKeyPem});
  report.fixtureMethod='OWNER_SEEDED_LEGACY_UNKNOWN_WITH_SYNTHETIC_SOFTWARE_SIGNING';report.original={sha256:original.sha256,byteSize:original.byteSize};report.manifestSha256=finalized.manifest.sha256;
  check('synthetic_frozen_original_and_signed_manifest_created_at_91');check('fixture_private_signing_file_removed');
 }else if(mode==='migrate'){
  const before=await frozen(db);assert.equal((await db.query("SELECT 1 FROM recipient_export_jobs WHERE state NOT IN ('READY','FAILED')")).rows.length,0);
  assert.equal((await db.query('SELECT 1 FROM platform_organizations')).rows.length,0);
  await db.transaction(async tx=>{
   for(const pin of M2_BRIDGE_MIGRATIONS){
    const sql=await readFile(new URL(`../tests/fixtures/m2-migrations/${pin.id}.sql`,import.meta.url),'utf8');assert.equal(hash(sql),pin.checksum);
    for(const stmt of splitSqlStatements(sql))await tx.query(stmt);
    await tx.query("INSERT INTO schema_migrations(id,checksum,applied_at,checksum_provenance) VALUES($1,$2,NOW(),'EXECUTED_BYTES')",[pin.id,pin.checksum]);
   }
  });
  assert.deepEqual(await frozen(db),before);report.frozen=before;
  check('exact_three_migrations_committed_together');check('preexisting_signed_original_and_approved_export_rows_unchanged');
 }else{
  phase='readiness';await assertSchemaCurrent(db);assert.equal((await db.query('SELECT COUNT(*) AS n FROM schema_migrations')).rows[0].n,mode==='before'?'91':'94');check('compiled_schema_readiness');
  const authority=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS can_create FROM pg_roles WHERE rolname=current_user")).rows[0];assert.ok(Object.values(authority).every(x=>x===false));check('separate_non_owner_login_without_schema_authority');
  const fixture=await read('fixture.json');
  const row=(await db.query('SELECT canonical_json,sha256,signature_algorithm,signing_key_id,signature_base64,signed_at FROM final_manifests WHERE proof_id=$1',[fixture.proofId])).rows[0];
  assert.equal(row.sha256,fixture.manifestSha256);assert.equal(hash(row.canonical_json),fixture.manifestSha256);
  assert.equal(verifyManifestIntegrity({canonicalJson:row.canonical_json,expectedSha256:row.sha256,publicKeyPem:fixture.publicKeyPem,signature:{algorithm:row.signature_algorithm,keyId:row.signing_key_id,signatureBase64:row.signature_base64,signedAt:String(row.signed_at)}}).signatureValid,true);
  const original=await store.digest(fixture.original.key,{versionId:fixture.original.versionId});assert.equal(original.sha256,fixture.original.sha256);assert.equal(original.byteSize,fixture.original.byteSize);check('frozen_signature_and_exact_original_bytes_verified');
  const replay=await finalizeProof(db,clock,fixture.actor,fixture.proofId);assert.equal(replay.manifest.sha256,fixture.manifestSha256);check('finalize_replay_keeps_frozen_signed_record');
  phase='compiled_http';
  const app=createServerApp({db,objectStore:store,clock,auth:new BearerUserAdapter(db),publicBaseUrl:'http://127.0.0.1',devAuth:true,testFixtures:true,credentialStore:new MemoryCredentialStore(),integrations:createDefaultIntegrationRegistry(clock,{testFixtures:true}),ebayDeletionSignatureVerifier:async()=>undefined});
  server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+`/proofs/${fixture.proofId}`,{headers:{Authorization:`Bearer ${fixture.actor}`}})).status,200);
  assert.ok([403,404].includes((await fetch(base+`/proofs/${fixture.proofId}`,{headers:{Authorization:`Bearer ${fixture.other}`}})).status));check('compiled_http_owner_read_and_wrong_actor_denial_with_synthetic_dev_auth');
  phase='recipient';
  if(mode==='after'){
   const historical=await read('before-result.json');const same=await downloadRecipientExport(db,store,fixture.actor,fixture.proofId,historical.jobId);
   assert.equal(hash(same),historical.downloadSha256);check('pre_migration_approved_download_is_byte_identical');
   for(const table of ['integrity_envelope_jobs','claim_cases','recipient_export_preservations'])await assert.rejects(()=>db.query(`SELECT * FROM ${table}`),e=>e.code==='42501');check('new_m2_tables_remain_unreadable_to_bridge');
  }
  const snapshot=await createSignatureSnapshot(db,clock,fixture.actor,fixture.proofId);
  const packet=await buildSignatureCase(db,clock,fixture.actor,fixture.proofId,{snapshotId:snapshot.snapshotId,template:'WRONG_ITEM',scope:{fields:['status','order','shipping','evidence','statements'],evidenceIds:[fixture.evidenceId]}});
  const input={caseId:packet.caseId,profileId:RECIPIENT_PROFILES[1].id,idempotencyKey:'synthetic-'+mode,destinationInstructionsReviewed:true,destinationDeadline:'2026-09-12T12:00:00Z',narrative:'Synthetic test video; no physical shipment assertion.',frames:[{evidenceId:fixture.evidenceId,offsetMs:50,label:'Synthetic test frame'}]};
  const job=await queueRecipientExport(db,clock,fixture.actor,fixture.proofId,input);
  assert.deepEqual(await processRecipientExport(db,clock,store),{processed:1,failed:0});
  const ready=await getRecipientExport(db,fixture.actor,fixture.proofId,job.jobId);assert.equal(ready.state,'READY');check('legacy_compiled_renderer_finishes_under_new_terminal_guard');
  await assert.rejects(()=>readRecipientExportFile(db,store,fixture.actor,fixture.proofId,job.jobId,0),e=>e.code==='EXPORT_APPROVAL_REQUIRED');
  const preview=await readRecipientExportFile(db,store,fixture.actor,fixture.proofId,job.jobId,0,true);
  await assert.rejects(()=>approveRecipientExport(db,clock,store,fixture.actor,fixture.proofId,job.jobId,{artifactSha256:'wrong',legibilityConfirmed:true}),e=>e.code==='EXPORT_PREVIEW_CHANGED');
  await approveRecipientExport(db,clock,store,fixture.actor,fixture.proofId,job.jobId,{artifactSha256:ready.artifactSha256,legibilityConfirmed:true});
  const approved=await readRecipientExportFile(db,store,fixture.actor,fixture.proofId,job.jobId,0);assert.ok(approved.bytes.equals(preview.bytes));
  const download=await downloadRecipientExport(db,store,fixture.actor,fixture.proofId,job.jobId);assert.equal(download.subarray(0,2).toString(),'PK');
  await assert.rejects(()=>getRecipientExport(db,fixture.other,fixture.proofId,job.jobId));check('exact_approval_download_and_wrong_actor_denial');
  if(mode==='after'){await assert.rejects(()=>db.query("UPDATE recipient_export_jobs SET attempts=attempts+1 WHERE id=$1",[job.jobId]),e=>e.message.includes('RECIPIENT_EXPORT_IMMUTABLE'));check('accepted_terminal_row_cannot_change');}
  assert.equal((await db.query('SELECT sha256 FROM final_manifests WHERE proof_id=$1',[fixture.proofId])).rows[0].sha256,fixture.manifestSha256);
  report.result={jobId:job.jobId,artifactSha256:ready.artifactSha256,downloadSha256:hash(download),downloadBytes:download.length,manifestSha256:fixture.manifestSha256,originalSha256:original.sha256};
  await save(mode+'-result.json',report.result);
 }
 report.status='PASSED';
}catch(error){report.status='FAILED';report.failure={phase,name:error.name,code:error.code??null,assertion:error.name==='AssertionError'?String(error.message).slice(0,350):undefined};process.exitCode=1;}
finally{if(server)await new Promise(resolve=>server.close(resolve));await opened?.close();report.observedAt=new Date().toISOString();console.log(JSON.stringify(report));}
