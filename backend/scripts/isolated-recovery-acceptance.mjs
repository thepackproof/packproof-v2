import assert from 'node:assert/strict';
import { randomBytes, createPublicKey } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetObjectRetentionCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { createPgDatabase } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { splitSqlStatements } from '../src/db/sql.ts';
import { AwsS3ObjectStore } from '../src/s3/aws-s3-object-store.ts';
import { initializeManifestSigningRuntime } from '../src/integrity/kms-signing-runtime.ts';
import { insertUser } from '../src/domain/users.ts';
import { createOrganization, setOrganizationEntitlement, addOrganizationMember, createServicePrincipal, issuePartnerCredential, createDelegation, createIntegrationAccount, revokeDelegation, authenticatePartner, PARTNER_SCOPES } from '../src/platform/organizations.ts';
import { importPartnerOrder, requestOperatorCapture } from '../src/platform/partner-proofs.ts';
import { bindIntent, sealCapture } from '../src/capture/service.ts';
import { CORE_VERSION, chainSegment, createManifest, manifestDigest } from '../src/capture/core.ts';
import { completeCaptureSession } from '../src/domain/capture-sessions.ts';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.ts';
import { commitAttestation } from '../src/domain/attestations.ts';
import { finalizeProof } from '../src/domain/finalize.ts';
import { authorizeProofAccess } from '../src/domain/proof-access.ts';
import { processRecoveryOutbox, enqueueRecoveryEvent, verifyRecoveryEnvelope } from '../src/domain/recovery-journal.ts';
import { processPolicyRecoveryOutbox, inspectPolicyRecoveryReconciliation, assertPolicyAccessSafe } from '../src/domain/policy-recovery.ts';
import { restoreFreshRecoveryDatabase } from '../src/domain/recovery-restore.ts';
import { exportEvidencePackage } from '../src/domain/evidence-review.ts';
import { sha256Hex } from '../src/hash.ts';

// This executable is intentionally unusable outside the owner-approved synthetic foundation.
assert.equal(process.env.PACKPROOF_TEST_PURPOSE,'isolated-m1-synthetic');
assert.equal(process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION,'us-east-1');
assert.equal(process.env.PACKPROOF_TEST_DB_HOST,'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com');
const region='us-east-1',account='784514617543',rolePrefix='packproof-m1-20261020-recovery';
const buckets={upload:'packproof-m1-20261020-uploadbucket-8o4ikwomdg8h',committed:'packproof-m1-20261020-committedbucket-trlqhna2z8s5',recovery:'packproof-m1-20261020-recoverybucket-aripohrxorbp'};
const manifestKey=`arn:aws:kms:${region}:${account}:key/6d65691f-a10c-4547-b806-896c3d660493`;
const recoveryKey=`arn:aws:kms:${region}:${account}:key/1730036e-b64f-4137-8a1d-11964782b97d`;
const runId=randomBytes(8).toString('hex'),journalPrefix=`acceptance/recovery/${runId}/`,controlPrefix=`acceptance/recovery/control/${runId}/`;
const sourceName=`m1_source_${runId}`,targetName=`m1_restore_${runId}`;
const roles={api:`m1_api_${runId}`,worker:`m1_worker_${runId}`,restore:`packproof_restore_${runId}`};
const passwords=Object.fromEntries(Object.keys(roles).map(k=>[k,randomBytes(32).toString('hex')]));
const secret=JSON.parse(process.env.ISOLATED_DB_SECRET??'{}');delete process.env.ISOLATED_DB_SECRET;
assert.equal(secret.username,'packproof');assert.equal(typeof secret.password,'string');
process.env.PACKPROOF_DB_CA_FILE='/tmp/packproof-rds-ca.pem';
process.env.PACKPROOF_ORGANIZATIONS_ENABLED='true';
process.env.PACKPROOF_EVENT_CURSOR_KEY=randomBytes(32).toString('base64');
const connection=(database,user=secret.username,password=secret.password)=>{
 const u=new URL(`postgresql://${process.env.PACKPROOF_TEST_DB_HOST}:5432/${database}`);u.username=user;u.password=password;u.searchParams.set('sslmode','verify-full');return u.toString();
};
const opened=[],createdDatabases=[],createdRoles=[];
const open=(database,user,password)=>{const o=createPgDatabase(connection(database,user,password));opened.push(o);return o.db;};
const admin=open('packproof_v2'),clock={now:()=>new Date()};
const report={schema:'packproof.isolated-recovery-acceptance.v1',runId,source:process.env.CANDIDATE_SHA,buildId:process.env.CODEBUILD_BUILD_ID,startedAt:clock.now().toISOString(),databaseHost:process.env.PACKPROOF_TEST_DB_HOST,sourceDatabase:sourceName,targetDatabase:targetName,journalPrefix,checks:[],limits:['Synthetic actors and repository camera fixture; no actual device session','Role-scoped SDK clients and separate PostgreSQL logins in an acceptance coordinator; no deployed API or worker service','Pinned public keys and signed heads collected with a separate read-only role; independent human review remains open','Target remains closed to traffic; this does not authorize production cutover']};
let phase='bootstrap',failed=false;
await mkdir('acceptance-artifacts',{recursive:true});
const save=async()=>writeFile('acceptance-artifacts/recovery-acceptance.json',JSON.stringify(report,null,2)+'\n');
const check=(name,facts={})=>{report.checks.push({name,passed:true,...facts});console.log(JSON.stringify({event:'recovery_acceptance_check',name}));};
const denied=async(fn,label)=>{let code;try{await fn();}catch(e){code=e.name??e.code;if(e.code==='42501')code='42501';}assert.ok(['AccessDenied','AccessDeniedException','42501'].includes(code),`${label}: expected access denial, received ${code??'success'}`);check(label,{code});};
const assume=suffix=>{
 const arn=`arn:aws:iam::${account}:role/${rolePrefix}-${suffix}`;
 const r=spawnSync('aws',['sts','assume-role','--role-arn',arn,'--role-session-name',`m1-${runId}-${suffix}`,'--duration-seconds','3600','--output','json'],{encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(r.status,0,`Assume ${suffix} role failed`);const c=JSON.parse(r.stdout).Credentials;
 return {accessKeyId:c.AccessKeyId,secretAccessKey:c.SecretAccessKey,sessionToken:c.SessionToken};
};
const coordinator=new S3Client({region,maxAttempts:3});
const putControl=async(name,data)=>coordinator.send(new PutObjectCommand({Bucket:buckets.upload,Key:controlPrefix+name,Body:JSON.stringify(data),ContentType:'application/json'}));
try {
 phase='role-and-storage-probes';
 const apiCredentials=assume('api'),workerCredentials=assume('worker'),readerCredentials=assume('reader');
 const apiS3=new S3Client({region,credentials:apiCredentials}),workerS3=new S3Client({region,credentials:workerCredentials}),readerS3=new S3Client({region,credentials:readerCredentials});
 const apiKms=new KMSClient({region,credentials:apiCredentials}),workerKms=new KMSClient({region,credentials:workerCredentials}),readerKms=new KMSClient({region,credentials:readerCredentials});
 const publicKeys={};
 for(const key of [manifestKey,recoveryKey]){const p=await readerKms.send(new GetPublicKeyCommand({KeyId:key}));assert.equal(p.KeyId,key);publicKeys[key]=createPublicKey({key:Buffer.from(p.PublicKey),format:'der',type:'spki'}).export({format:'pem',type:'spki'}).toString();}
 const trustedPublicKey=async id=>publicKeys[id]??null;
 await writeFile('acceptance-artifacts/public-trust.json',JSON.stringify({publicKeys},null,2));
 const signProbe={KeyId:recoveryKey,Message:Buffer.alloc(32),MessageType:'DIGEST',SigningAlgorithm:'ECDSA_SHA_256'};
 await denied(()=>apiKms.send(new SignCommand(signProbe)),'api_recovery_signing_denied');
 await denied(()=>workerKms.send(new SignCommand({...signProbe,KeyId:manifestKey})),'worker_manifest_signing_denied');
 await denied(()=>readerKms.send(new SignCommand(signProbe)),'restore_reader_signing_denied');
 const probeKey=journalPrefix+'probe.txt',body=Buffer.from('SYNTHETIC isolated protected journal probe');
 const putProbe={Bucket:buckets.recovery,Key:probeKey,Body:body,ChecksumSHA256:Buffer.from(sha256Hex(body),'hex').toString('base64'),IfNoneMatch:'*'};
 await denied(()=>apiS3.send(new PutObjectCommand(putProbe)),'api_journal_write_denied');
 const probe=await workerS3.send(new PutObjectCommand(putProbe));assert.ok(probe.VersionId);
 await denied(()=>workerS3.send(new DeleteObjectCommand({Bucket:buckets.recovery,Key:probeKey,VersionId:probe.VersionId})),'worker_version_delete_denied');
 await denied(()=>apiS3.send(new GetObjectCommand({Bucket:buckets.recovery,Key:probeKey,VersionId:probe.VersionId})),'api_journal_read_denied');
 await assert.rejects(()=>workerS3.send(new PutObjectCommand(putProbe)),e=>e.name==='PreconditionFailed');check('journal_conditional_creation');
 const retention=await readerS3.send(new GetObjectRetentionCommand({Bucket:buckets.recovery,Key:probeKey,VersionId:probe.VersionId}));assert.equal(retention.Retention.Mode,'GOVERNANCE');assert.ok(retention.Retention.RetainUntilDate.getTime()>Date.now()+89*86400000);check('journal_version_retention',{key:probeKey,version:probe.VersionId,retention:retention.Retention});
 const signing=async(client,key)=>initializeManifestSigningRuntime(clock,{PACKPROOF_MANIFEST_SIGNING_MODE:'kms',PACKPROOF_MANIFEST_SIGNING_REQUIRED:'true',PACKPROOF_MANIFEST_KMS_KEY_ARN:key,PACKPROOF_MANIFEST_SIGNING_ALGORITHM:'ECDSA_SHA_256'},{getPublicKey:i=>client.send(new GetPublicKeyCommand(i)),sign:i=>client.send(new SignCommand(i))});
 const manifestSigning=await signing(apiKms,manifestKey),journalSigning=await signing(workerKms,recoveryKey);
 const media=new AwsS3ObjectStore(buckets.upload,{region,client:apiS3,committedBucket:buckets.committed});
 const journalStore=new AwsS3ObjectStore(buckets.recovery,{region,client:workerS3,immutableRecoveryJournal:true});
 const prefixed=store=>({putIfAbsent:(k,b,c)=>store.putIfAbsent(journalPrefix+k,b,c),get:(k,r)=>store.get(journalPrefix+k,r),head:(k,r)=>store.head(journalPrefix+k,r)});
 const publisher={store:prefixed(journalStore),signer:journalSigning.signer,trustedPublicKey,writerGeneration:'initial',protectedStoreVerified:true};

 phase='dedicated-databases-and-logins';
 for(const name of [sourceName,targetName]){assert.match(name,/^m1_(source|restore)_[a-f0-9]{16}$/);await admin.query(`CREATE DATABASE ${name}`);createdDatabases.push(name);await admin.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);}
 const ownerSource=open(sourceName),ownerTarget=open(targetName);await migrate(ownerSource);await migrate(ownerTarget);
 for(const [kind,name] of Object.entries(roles)){await admin.query(`CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[kind]}'`);createdRoles.push(name);}
 for(const sql of splitSqlStatements(await readFile(new URL('../../infra/sql/runtime-roles.sql',import.meta.url),'utf8')))await ownerSource.query(sql);
 await ownerSource.query(`GRANT packproof_runtime TO ${roles.api}`);
 await ownerSource.query(`GRANT packproof_runtime,packproof_recovery TO ${roles.worker}`);
 await admin.query(`GRANT CONNECT ON DATABASE ${sourceName} TO ${roles.api},${roles.worker}`);
 await admin.query(`GRANT CONNECT ON DATABASE ${targetName} TO ${roles.restore}`);
 await ownerTarget.query(`GRANT USAGE ON SCHEMA public TO ${roles.restore}`);
 await ownerTarget.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${roles.restore}`);
 await ownerTarget.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${roles.restore}`);
 const api=open(sourceName,roles.api,passwords.api),worker=open(sourceName,roles.worker,passwords.worker),target=open(targetName,roles.restore,passwords.restore);
 for(const [kind,db] of [['api',api],['worker',worker],['restore',target]]){const who=(await db.query('SELECT current_user AS role,current_database() AS database,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user')).rows[0];assert.equal(who.role,roles[kind]);assert.ok(!who.rolsuper&&!who.rolcreatedb&&!who.rolcreaterole&&!who.rolbypassrls);check(`${kind}_database_login`,who);}
 await denied(()=>api.query("UPDATE recovery_writer_fence SET writes_enabled=true WHERE singleton=1"),'api_cannot_reopen_database_fence');
 await denied(()=>api.query("UPDATE recovery_delivery SET state='DURABLE' WHERE false"),'api_cannot_publish_receipts');
 await denied(()=>worker.query("UPDATE recovery_writer_fence SET generation='other' WHERE singleton=1"),'worker_cannot_change_generation');
 await denied(()=>api.query('CREATE TABLE public.forbidden_runtime_ddl(id integer)'),'api_cannot_create_schema_objects');
 const drain=async()=>{
  for(const [label,fn] of [['policy',processPolicyRecoveryOutbox],['core',processRecoveryOutbox]]){
   for(let i=0;i<1500;i++){const r=await fn(worker,clock,publisher);if(!r.processed)break;assert.equal(r.state,'DURABLE',`${label} publisher failed at ${i}`);assert.ok(i<1499,'Publisher did not drain');}
  }
 };

 phase='organization-fixtures-and-real-storage';
 const [developer,owner,operator]=await Promise.all(Array.from({length:3},()=>insertUser(api,clock)));
 // A synthetic fixture uses the existing developer entitlement; this is not Cognito/MFA evidence.
 await ownerSource.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[developer,clock.now().toISOString()]);
 const merchant=(await createOrganization(api,clock,developer,{kind:'MERCHANT',name:'Synthetic recovery merchant',ownerUserId:owner},runId)).id;
 const partner=(await createOrganization(api,clock,developer,{kind:'PARTNER',name:'Synthetic recovery partner'},runId)).id;
 for(const id of [merchant,partner])await setOrganizationEntitlement(api,clock,developer,id,{enabled:true},runId);
 const member=(await addOrganizationMember(api,clock,developer,partner,{userId:operator,role:'OPERATOR'},runId)).id;
 const principal=(await createServicePrincipal(api,clock,developer,partner,{name:'Synthetic recovery principal'},runId)).id;
 const expiresAt=new Date(Date.now()+86400000).toISOString();
 const credential=(await issuePartnerCredential(api,clock,developer,partner,principal,{scopes:[...PARTNER_SCOPES],expiresAt},runId)).token;
 const grant=(await createDelegation(api,clock,owner,merchant,{partnerOrganizationId:partner,scopes:[...PARTNER_SCOPES],operatorUserIds:[operator],expiresAt},runId)).id;
 const integration=(await createIntegrationAccount(api,clock,owner,merchant,{provider:'reference',externalAccountId:runId},runId)).id;
 const actor=await authenticatePartner(api,clock,`Bearer ${credential}`,merchant,grant,runId);
 const proofId=(await importPartnerOrder(api,clock,actor,{integrationAccountId:integration,externalId:'SYNTHETIC-RESTORE',operatorMembershipId:member,transaction:{itemTitle:'Synthetic restoration specimen',quantity:1}})).proofId;
 const intent=await requestOperatorCapture(api,clock,actor,proofId,{allowedSurfaces:['WEB']});
 const capabilities={surface:'WEB',cameraSource:'UNKNOWN',timing:'MONOTONIC',barcode:false,itemVisibility:false,durableJournal:true,incrementalMedia:false,audio:false,deviceAuthentication:'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:10000000,coreVersion:CORE_VERSION};
 const bound=await bindIntent(api,clock,operator,{launchToken:intent.launchToken,capabilities});
 const bytes=await readFile(new URL('../tests/fixtures/camera-recording.mp4',import.meta.url));
 const source={sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'video/mp4',durationMs:200},hash=async x=>sha256Hex(x);
 const segment=await chainSegment({sequence:0,offsetBytes:0,byteSize:bytes.length,sha256:source.sha256,previous:null,startMs:0,endMs:200,timing:'WHOLE_RECORDING'},hash);
 const observations=[{id:'start',captureId:bound.session.id,type:'CAPTURE_STARTED',startMs:0,endMs:0,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'},{id:'end',captureId:bound.session.id,type:'CAPTURE_ENDED',startMs:200,endMs:200,source:'DEVICE',model:null,confidence:null,value:null,timePrecision:'APPROXIMATE'}];
 const captureManifest=await createManifest(bound.context,source,[segment],observations,hash);
 await completeCaptureSession(api,clock,operator,proofId,bound.session.id,{...source,recordedDurationMs:200});
 await sealCapture(api,clock,operator,bound.session.id,{source,segments:[segment],observations,sha256:await manifestDigest(captureManifest,hash)});
 const upload=await initializeEvidenceUpload(api,clock,media,operator,proofId,{contentType:'video/mp4',evidenceType:'FULFILLMENT_CAPTURE',captureSessionId:bound.session.id,idempotencyKey:runId});
 await media.put(upload.objectKey,bytes,'video/mp4');await commitEvidence(api,clock,media,operator,proofId,upload.evidenceId);
 await commitAttestation(api,clock,operator,proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:upload.evidenceId});
 await drain();
 await finalizeProof(api,clock,operator,proofId,manifestSigning.signer,{requireDurableReceipts:true});await drain();
 const final=await finalizeProof(api,clock,operator,proofId,manifestSigning.signer,{requireDurableReceipts:true});assert.equal(final.proof.status,'FINALIZED');
 const originalPackage=await exportEvidencePackage(api,clock,media,operator,proofId);
 await writeFile('acceptance-artifacts/before.pkpr',originalPackage);await writeFile('acceptance-artifacts/before-manifest.json',final.manifest.canonicalJson);
 const retainedMedia=(await api.query('SELECT object_key,object_version_id,sha256,byte_size FROM evidence WHERE id=$1',[upload.evidenceId])).rows[0];
 const mediaRetention=await readerS3.send(new GetObjectRetentionCommand({Bucket:buckets.committed,Key:retainedMedia.object_key,VersionId:retainedMedia.object_version_id}));assert.equal(mediaRetention.Retention.Mode,'GOVERNANCE');
 check('shared_capture_and_kms_finalization',{proofId,manifestSha256:final.manifest.sha256,media:retainedMedia,retention:mediaRetention.Retention});
 await revokeDelegation(api,clock,owner,merchant,grant,runId);await drain();
 await assert.rejects(()=>authorizeProofAccess(api,proofId,operator),e=>e.code==='ORGANIZATION_ACCESS_REVOKED');check('source_revocation_enforced');

 phase='external-old-writer-fence';
 await ownerSource.query("UPDATE recovery_writer_fence SET writes_enabled=false,generation='retired' WHERE singleton=1");
 await assert.rejects(()=>enqueueRecoveryEvent(api,clock,{operationId:'fenced',kind:'PROOF_FINALIZED',proofId,actorUserId:operator,payload:{}}),e=>e.code==='RECOVERY_WRITERS_FENCED');check('source_database_writer_fence');
 // The coordinator cannot alter IAM. An external control-plane change closes the source roles.
 report.controlPrefix=controlPrefix;await save();
 await putControl('awaiting-fence.json',{runId,buildId:process.env.CODEBUILD_BUILD_ID,source:process.env.CANDIDATE_SHA,apiRole:`${rolePrefix}-api`,workerRole:`${rolePrefix}-worker`,databaseFence:true});
 console.log(JSON.stringify({event:'awaiting_external_writer_fence',controlPrefix,runId}));
 let signal;
 for(let i=0;i<144;i++){try{const r=await coordinator.send(new GetObjectCommand({Bucket:buckets.upload,Key:controlPrefix+'fence-complete.json'}));signal=JSON.parse(await r.Body.transformToString());break;}catch(e){if(!['NoSuchKey','AccessDenied'].includes(e.name))throw e;}await delay(5000);}
 assert.equal(signal?.runId,runId,'External writer fence was not confirmed');assert.equal(signal?.writerFence,'CLOSED');
 // Probe the already-issued credentials, not freshly assumed replacement sessions.
 await denied(()=>workerS3.send(new PutObjectCommand({...putProbe,Key:journalPrefix+'fenced-worker.txt'})),'old_worker_session_write_denied');
 await denied(()=>workerKms.send(new SignCommand(signProbe)),'old_worker_session_signing_denied');
 await denied(()=>apiS3.send(new PutObjectCommand({Bucket:buckets.upload,Key:`evidence/fence-${runId}/probe/object`,Body:body})),'old_api_session_write_denied');
 await denied(()=>apiKms.send(new SignCommand({...signProbe,KeyId:manifestKey})),'old_api_session_signing_denied');
 for(const kind of ['api','worker']){await admin.query(`ALTER ROLE ${roles[kind]} NOLOGIN`);await ownerSource.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()',[roles[kind]]);const refused=createPgDatabase(connection(sourceName,roles[kind],passwords[kind]));try{await assert.rejects(()=>refused.db.query('SELECT 1'));}finally{await refused.close();}}
 check('source_database_sessions_disabled');report.externalFence=signal;

 phase='read-only-journal-inventory';
 const readerJournal=prefixed(new AwsS3ObjectStore(buckets.recovery,{region,client:readerS3,immutableRecoveryJournal:true}));
 const readerMedia=new AwsS3ObjectStore(buckets.committed,{region,client:readerS3});
 const sourceStore={get:(k,r)=>k.startsWith('recovery/')?readerJournal.get(k,r):readerMedia.get(k,r),head:(k,r)=>k.startsWith('recovery/')?readerJournal.head(k,r):readerMedia.head(k,r),getStream:(k,r)=>readerMedia.getStream(k,r)};
 const core=[],policy=[],inventory=[];let ContinuationToken;
 do{const listing=await readerS3.send(new ListObjectsV2Command({Bucket:buckets.recovery,Prefix:journalPrefix+'recovery/',ContinuationToken}));
  for(const obj of listing.Contents??[]){const k=obj.Key.slice(journalPrefix.length),head=await readerJournal.head(k);const record=await readerJournal.get(k,{versionId:head.versionId});const envelope=JSON.parse(record.body),event=JSON.parse(envelope.eventCanonicalJson);const lock=await readerS3.send(new GetObjectRetentionCommand({Bucket:buckets.recovery,Key:obj.Key,VersionId:head.versionId}));assert.equal(lock.Retention.Mode,'GOVERNANCE');assert.ok(lock.Retention.RetainUntilDate.getTime()>Date.now()+89*86400000);inventory.push({key:obj.Key,versionId:head.versionId,sha256:sha256Hex(record.body),retention:lock.Retention});(k.startsWith('recovery/policy/')?policy:core).push({bytes:record.body,sequence:BigInt(event.sequence)});}
  ContinuationToken=listing.IsTruncated?listing.NextContinuationToken:undefined;
 }while(ContinuationToken);
 for(const list of [core,policy])list.sort((a,b)=>a.sequence<b.sequence?-1:1);
 assert.ok(core.length&&policy.length);check('readonly_signed_head_inventory',{coreObjects:core.length,policyObjects:policy.length,exactVersions:inventory.length});
 report.inventory=inventory;
 const coreHead=core.at(-1).bytes,policyHead=policy.at(-1).bytes;
 await writeFile('acceptance-artifacts/core-head.json',coreHead);await writeFile('acceptance-artifacts/policy-head.json',policyHead);
 await assert.rejects(()=>verifyRecoveryEnvelope(Buffer.from(coreHead.toString().replace('PACKPROOF_SIGNED_RECOVERY_ENVELOPE','TAMPERED')),publisher));
 await assert.rejects(()=>verifyRecoveryEnvelope(coreHead,{...publisher,trustedPublicKey:async()=>publicKeys[manifestKey]}));check('tampered_and_wrong_key_envelopes_denied');
 const input={expectedDatabase:targetName,restoreRole:roles.restore,isolatedTargetReference:`isolated-rds:${targetName}`,oldWriterFenceReference:`s3://${buckets.upload}/${controlPrefix}fence-complete.json`,targetWriterGeneration:`replacement-${runId}`,core:{envelopes:core.map(x=>x.bytes),expectedWatermark:coreHead},policy:{envelopes:policy.map(x=>x.bytes),expectedWatermark:policyHead},trustedPublicKey,sourceStore};

 phase='fresh-database-restore';
 await assert.rejects(()=>restoreFreshRecoveryDatabase(target,{...input,core:{...input.core,expectedWatermark:core[0].bytes}}),e=>e.code==='RECOVERY_RESTORE_HEAD_MISMATCH');check('incomplete_restore_head_denied');
 const started=performance.now();report.restore=await restoreFreshRecoveryDatabase(target,input);report.restoreElapsedMs=performance.now()-started;
 const restored=(await target.query('SELECT canonical_json,sha256,signature_base64,signing_key_id FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];
 assert.equal(restored.canonical_json,final.manifest.canonicalJson);assert.equal(restored.sha256,final.manifest.sha256);
 const sourceManifest=(await ownerSource.query('SELECT canonical_json,sha256,signature_base64,signing_key_id FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];assert.deepEqual(restored,sourceManifest);
 await writeFile('acceptance-artifacts/after-manifest.json',restored.canonical_json);
 // Migration 092 intentionally omits credential usage telemetry from the policy
 // journal. Compare every authority field; never emit credential hashes in diffs.
 for(const table of ['platform_organizations','platform_memberships','platform_principals','platform_credentials','platform_delegations','platform_integration_accounts','platform_proof_ownership','platform_external_bindings','platform_capture_authorizations']){
  const projection=table==='platform_credentials'?"to_jsonb(t)-'last_used_at'":'to_jsonb(t)';
  const sql=`SELECT ${projection} AS row FROM ${table} t ORDER BY (${projection})::text`;
  assert.ok(JSON.stringify((await target.query(sql)).rows)===JSON.stringify((await ownerSource.query(sql)).rows),`${table} authority restoration differs`);
 }
 assert.equal((await target.query('SELECT count(*)::int AS n FROM platform_credentials WHERE last_used_at IS NOT NULL')).rows[0].n,0);
 assert.ok((await target.query('SELECT revoked_at FROM platform_delegations WHERE id=$1',[grant])).rows[0].revoked_at);
 assert.equal((await inspectPolicyRecoveryReconciliation(target)).matches,true);
 await assert.rejects(()=>assertPolicyAccessSafe(target),e=>e.code==='POLICY_RECOVERY_UNAVAILABLE');
 await assert.rejects(()=>authorizeProofAccess(target,proofId,operator),e=>['ORGANIZATION_ACCESS_REVOKED','POLICY_RECOVERY_UNAVAILABLE'].includes(e.code));
 await assert.rejects(()=>target.query("UPDATE final_manifests SET canonical_json='{}' WHERE proof_id=$1",[proofId]));
 assert.deepEqual((await target.query('SELECT writes_enabled,generation FROM recovery_writer_fence')).rows[0],{writes_enabled:false,generation:`replacement-${runId}`});
 check('fresh_restore_preserves_manifest_and_revoked_authority',{manifestSha256:restored.sha256,organizationTablesCompared:9,excludedTelemetry:['platform_credentials.last_used_at'],trafficMayOpen:false,writersEnabled:false});
 report.completedAt=clock.now().toISOString();report.status='PASSED';await save();
 await putControl('completed.json',{runId,status:'PASSED',checks:report.checks.length});
} catch(error){failed=true;report.status='FAILED';report.failure={phase,code:String(error.code??error.name??'ERROR'),message:String(error.message??'').replace(/postgres(?:ql)?:\/\/\S+/g,'[REDACTED CONNECTION]').slice(0,500)};for(const value of [secret.password,...Object.values(passwords)])report.failure.message=report.failure.message.replaceAll(value,'[REDACTED]');console.error(JSON.stringify({event:'recovery_acceptance_failed',...report.failure}));await save();}
finally{
 for(const o of opened.slice(1).reverse())await o.close().catch(()=>{});
 report.cleanup={databases:[],roles:[]};
 for(const name of createdDatabases.reverse()){try{await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);report.cleanup.databases.push({name,removed:true});}catch(e){report.cleanup.databases.push({name,removed:false,code:e.code});failed=true;}}
 for(const name of createdRoles.reverse()){try{await admin.query(`DROP ROLE ${name}`);report.cleanup.roles.push({name,removed:true});}catch(e){report.cleanup.roles.push({name,removed:false,code:e.code});failed=true;}}
 await opened[0].close();if(failed&&report.status==='PASSED')report.status='FAILED_CLEANUP';await save();
 await putControl('report.json',report);
}
if(failed)process.exitCode=1;
