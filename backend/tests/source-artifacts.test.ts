import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {openIsolatedTestDatabase} from './isolated-test-database.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createOrganization,setOrganizationEntitlement,createServicePrincipal,issuePartnerCredential,createIntegrationAccount,authenticatePartner,addOrganizationMember,createDelegation,PARTNER_SCOPES,type PartnerActor} from '../src/platform/organizations.js';
import {importPartnerOrder} from '../src/platform/partner-proofs.js';
import {requireRecordWorkspace,type RecordWorkspace} from '../src/records/access.js';
import {actOnRecordConnection} from '../src/records/connections.js';
import {LocalObjectStore} from '../src/s3/local-object-store.js';
import {sha256Hex} from '../src/hash.js';
import {evidenceObjectKey} from '../src/s3/object-key.js';
import {initializeSourceArtifact,receiveSourceArtifactBytes,assembleSourceArtifactParts,completeSourceArtifact,processSourceArtifactCompletions,readSourceUploadSession,readSourceArtifactOperation,listSourceArtifacts,readPartnerArtifactOrEvidenceStream,verifyRestoredSourceArtifacts,SOURCE_ARTIFACT_LIMITS,type SourceArtifactActor} from '../src/records/source-artifacts.js';
import type {ObjectStore} from '../src/s3/object-store.js';
import {buildProofRecoverySnapshot} from '../src/domain/recovery-journal.js';

describe('organization source artifact originals',()=>{
 let opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>,directory:string,store:LocalObjectStore,admin:string,owner:string,org:string,account:string,proof:string,otherProof:string,actor:PartnerActor,human:SourceArtifactActor,workspace:RecordWorkspace;
 let offset=0,index=0;const clock={now:()=>new Date(Date.now()+offset)};
 const png=(n=128)=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(n-8,17)]);
 const input=(bytes=png(),extra:Record<string,unknown>={})=>({proofId:proof,connectionId:account,sourceArtifactId:`original-${++index}`,filename:'original.png',contentType:'image/png',byteSize:bytes.length,reportedAt:'2026-11-03T12:00:00-05:00',...extra});
 const partner=():SourceArtifactActor=>({kind:'partner',partner:actor});
 async function freshActor(){const token=(await issuePartnerCredential(opened.db,clock,owner,org,actor.principalId,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'test')).token;return authenticatePartner(opened.db,clock,`Bearer ${token}`,org,undefined,'test');}
 async function init(bytes=png(),extra:Record<string,unknown>={},a=partner()){return initializeSourceArtifact(opened.db,clock,a,input(bytes,extra),`source-${++index}`);}
 async function queue(bytes=png(),a=partner()){const s=await init(bytes,{},a);await receiveSourceArtifactBytes(opened.db,clock,store,a,s.sessionId,Readable.from([bytes]),bytes.length);return {session:s,operation:await completeSourceArtifact(opened.db,clock,a,s.sessionId)};}
 async function done(bytes=png()){const q=await queue(bytes);await processSourceArtifactCompletions(opened.db,clock,store,10);expect((await readSourceArtifactOperation(opened.db,clock,partner(),q.operation.operationId)).state).toBe('succeeded');return q;}
 beforeAll(async()=>{
  vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');opened=await openIsolatedTestDatabase();await migrate(opened.db);
  directory=await mkdtemp(path.join(os.tmpdir(),'source-artifacts-'));store=new LocalObjectStore(directory,'http://example.test','test');
  admin=await insertUser(opened.db,clock);owner=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,clock.now().toISOString()]);
  org=(await createOrganization(opened.db,clock,admin,{kind:'MERCHANT',name:'Source artifact tenant',ownerUserId:owner},'test')).id;
  await setOrganizationEntitlement(opened.db,clock,admin,org,{enabled:true},'test');
  const principal=await createServicePrincipal(opened.db,clock,owner,org,{name:'Source publisher'},'test');
  const token=(await issuePartnerCredential(opened.db,clock,owner,org,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'test')).token;
  actor=await authenticatePartner(opened.db,clock,`Bearer ${token}`,org,undefined,'test');
  account=(await createIntegrationAccount(opened.db,clock,owner,org,{provider:'artifact-fixture',externalAccountId:'fixture'},'test')).id;
  workspace=await requireRecordWorkspace(opened.db,owner,org,'sandbox',true);human={kind:'human',workspace};
  proof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'ARTIFACT-1',operatorMembershipId:workspace.membershipId,transaction:{itemTitle:'Original attachment record'}})).proofId;
  otherProof=(await importPartnerOrder(opened.db,clock,actor,{integrationAccountId:account,externalId:'ARTIFACT-2',operatorMembershipId:workspace.membershipId,transaction:{itemTitle:'Other record'}})).proofId;
 },60000);
 afterAll(async()=>{await opened?.close();if(directory){const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe test cleanup');await rm(resolved,{recursive:true,force:true});}vi.unstubAllEnvs();});
 it('durably reserves, receives, queues and preserves the exact original without capture or attestation',async()=>{
  const before=(await opened.db.query('SELECT status,manifest_id FROM proofs WHERE id=$1',[proof])).rows[0],bytes=png(),s=await init(bytes,{sha256:sha256Hex(bytes)});
  expect(s).toMatchObject({state:'open',sourceAssurance:'organization_submitted',reportedAt:'2026-11-03T17:00:00.000Z',receivedParts:[]});
  expect((await opened.db.query('SELECT 1 FROM record_source_artifact_results WHERE artifact_id=$1',[s.artifactId])).rows).toHaveLength(0);
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([bytes]),bytes.length);
  const op=await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);expect(op.state).toBe('queued');
  expect((await completeSourceArtifact(opened.db,clock,partner(),s.sessionId)).operationId).toBe(op.operationId);
  await processSourceArtifactCompletions(opened.db,clock,store);const result=await readSourceArtifactOperation(opened.db,clock,partner(),op.operationId);
  expect(result).toMatchObject({state:'succeeded',result:{sha256:sha256Hex(bytes),byteSize:bytes.length,contentType:'image/png'}});
  expect((await opened.db.query('SELECT status,manifest_id FROM proofs WHERE id=$1',[proof])).rows[0]).toEqual(before);
  expect((await opened.db.query('SELECT 1 FROM evidence WHERE proof_id=$1',[proof])).rows).toHaveLength(0);expect((await opened.db.query('SELECT 1 FROM attestations WHERE proof_id=$1',[proof])).rows).toHaveLength(0);
  expect((await opened.db.query('SELECT revision FROM record_state WHERE proof_id=$1',[proof])).rows[0]).toEqual({revision:5});
  expect((await opened.db.query("SELECT kind FROM recovery_events WHERE proof_id=$1 AND kind LIKE 'SOURCE_ARTIFACT%' ORDER BY sequence",[proof])).rows).toEqual([{kind:'SOURCE_ARTIFACT_RESERVED'},{kind:'SOURCE_ARTIFACT_RESERVED'},{kind:'SOURCE_ARTIFACT_COMPLETION_REQUESTED'},{kind:'SOURCE_ARTIFACT_COMMITTED'}]);
 });
 it('freezes the accepted staging VersionId even when latest staging is replaced',async()=>{
  const bytes=png(),q=await queue(bytes),key=evidenceObjectKey(proof,q.session.artifactId);
  const candidate=(await opened.db.query<{candidate_canonical:string}>('SELECT candidate_canonical FROM record_source_artifact_operations WHERE id=$1',[q.operation.operationId])).rows[0];expect(JSON.parse(candidate.candidate_canonical)).toMatchObject({sha256:sha256Hex(bytes),expectedSha256:null,byteSize:bytes.length});
  await store.put(key,png(129),'image/png');await processSourceArtifactCompletions(opened.db,clock,store);
  const result=await readSourceArtifactOperation(opened.db,clock,partner(),q.operation.operationId);expect(result.result?.sha256).toBe(sha256Hex(bytes));
  const media=await readPartnerArtifactOrEvidenceStream(opened.db,clock,store,actor,q.session.artifactId);const chunks=[];for await(const b of media.body!)chunks.push(Buffer.from(b));expect(Buffer.concat(chunks)).toEqual(bytes);
 });
 it('rejects corruption of the accepted version against the frozen server digest when no client hash was supplied',async()=>{
  const bytes=png(),q=await queue(bytes),s=(await opened.db.query<{staging_key:string;staging_version_id:string}>('SELECT staging_key,staging_version_id FROM record_source_upload_sessions WHERE id=$1',[q.session.sessionId])).rows[0];
  const exact=path.resolve(directory,`${s.staging_key}.versions`,s.staging_version_id.slice('local-staging-v1:'.length));if(!exact.startsWith(path.resolve(directory)+path.sep))throw Error('Unsafe corruption fixture');
  const changed=png();changed[100]=12;await writeFile(exact,changed);
  try{await processSourceArtifactCompletions(opened.db,clock,store);expect((await readSourceArtifactOperation(opened.db,clock,partner(),q.operation.operationId))).toMatchObject({state:'failed',errorCode:'EVIDENCE_HASH_MISMATCH',result:null});
   expect((await opened.db.query('SELECT 1 FROM record_source_artifact_results WHERE artifact_id=$1',[q.session.artifactId])).rows).toHaveLength(0);expect((await opened.db.query("SELECT kind FROM recovery_events WHERE operation_id=$1",[`${q.operation.operationId}:failed`])).rows[0]).toEqual({kind:'SOURCE_ARTIFACT_FAILED'});
  }finally{await writeFile(exact,bytes);}
 });
 it('replays initialization only within the same current credential and rejects changed requests/source identities',async()=>{
  const body=input(),s=await initializeSourceArtifact(opened.db,clock,partner(),body,'idempotent-original');
  const again=await initializeSourceArtifact(opened.db,clock,partner(),body,'idempotent-original');expect(again.sessionId).toBe(s.sessionId);expect(again.replayed).toBe(true);
  await expect(initializeSourceArtifact(opened.db,clock,partner(),{...body,filename:'other.png'},'idempotent-original')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(initializeSourceArtifact(opened.db,clock,partner(),body,'another-request')).rejects.toMatchObject({code:'SOURCE_ARTIFACT_CONFLICT'});
  const token=(await issuePartnerCredential(opened.db,clock,owner,org,actor.principalId,{scopes:[...PARTNER_SCOPES],expiresAt:new Date(Date.now()+86400000).toISOString()},'rotation')).token;
  const rotated=await authenticatePartner(opened.db,clock,`Bearer ${token}`,org,undefined,'rotation');
  await expect(readSourceUploadSession(opened.db,clock,{kind:'partner',partner:rotated},s.sessionId)).rejects.toMatchObject({code:'UPLOAD_NOT_FOUND'});
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([png()]),128);await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);
 });
 it('supports bounded resumable one-based parts and validates every exact part before assembly',async()=>{
  const bytes=png(SOURCE_ARTIFACT_LIMITS.partSize+111),s=await init(bytes);
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([bytes.subarray(0,SOURCE_ARTIFACT_LIMITS.partSize)]),SOURCE_ARTIFACT_LIMITS.partSize,1);
  expect((await readSourceUploadSession(opened.db,clock,partner(),s.sessionId)).receivedParts).toEqual([{partNumber:1,byteSize:SOURCE_ARTIFACT_LIMITS.partSize,sha256:sha256Hex(bytes.subarray(0,SOURCE_ARTIFACT_LIMITS.partSize))}]);
  await expect(assembleSourceArtifactParts(opened.db,clock,store,partner(),s.sessionId)).rejects.toMatchObject({code:'UPLOAD_PARTS_MISSING'});
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([bytes.subarray(SOURCE_ARTIFACT_LIMITS.partSize)]),111,2);
  expect((await assembleSourceArtifactParts(opened.db,clock,store,partner(),s.sessionId)).state).toBe('received');
  const op=await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);expect((await readSourceArtifactOperation(opened.db,clock,partner(),op.operationId)).result?.sha256).toBe(sha256Hex(bytes));
 });
 it('requires declared supported MIME/size, fixed exact part lengths and original magic bytes',async()=>{
  await expect(init(png(),{contentType:'text/html'})).rejects.toMatchObject({code:'INVALID_CONTENT_TYPE'});
  await expect(init(png(),{byteSize:250000001})).rejects.toMatchObject({code:'UPLOAD_TOO_LARGE'});
  await expect(init(png(),{filename:`pp_org_sandbox_${'a'.repeat(43)}`})).rejects.toMatchObject({code:'ARTIFACT_SECRET_FIELD'});
  const s=await init();await expect(receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([Buffer.alloc(128)]),128)).rejects.toMatchObject({code:'EVIDENCE_FORMAT_MISMATCH'});
  await expect(receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([png()]),127,1)).rejects.toMatchObject({code:'UPLOAD_SIZE_MISMATCH'});
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([png()]),128);await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);
 });
 it('fails closed when storage does not return an exact staging VersionId',async()=>{
  const s=await init(),unversioned={...store,putStream:async()=>({versionId:null}),getStream:store.getStream.bind(store)} as unknown as ObjectStore;
  await expect(receiveSourceArtifactBytes(opened.db,clock,unversioned,partner(),s.sessionId,Readable.from([png()]),128)).rejects.toMatchObject({code:'EVIDENCE_VERSIONING_REQUIRED'});
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([png()]),128);await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);
 });
 it('permits scoped human manual attachments and denies service personal powers and reviewer writes',async()=>{
  const s=await initializeSourceArtifact(opened.db,clock,human,input(png(),{connectionId:undefined}),'manual-source');expect(s.sourceAssurance).toBe('human_uploaded_attachment');
  await expect(readSourceUploadSession(opened.db,clock,partner(),s.sessionId)).rejects.toMatchObject({code:'UPLOAD_NOT_FOUND'});
  await receiveSourceArtifactBytes(opened.db,clock,store,human,s.sessionId,Readable.from([png()]),128);await completeSourceArtifact(opened.db,clock,human,s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);
  const reviewer=await insertUser(opened.db,clock);await addOrganizationMember(opened.db,clock,owner,org,{userId:reviewer,role:'REVIEWER'},'reviewer');
  const reviewActor:SourceArtifactActor={kind:'human',workspace:await requireRecordWorkspace(opened.db,reviewer,org,'sandbox')};await expect(initializeSourceArtifact(opened.db,clock,reviewActor,input(),`review-${++index}`)).rejects.toMatchObject({code:'RECORD_PERMISSION_DENIED'});
 });
 it('fences a worker whose external copy outlasts its lease and safely reconciles after reclaim',async()=>{
  const q=await queue(),slow=new Proxy(store,{get(target,key){if(key==='commitUpload')return async(...args:Parameters<ObjectStore['commitUpload']>)=>{const r=await target.commitUpload(...args);offset+=SOURCE_ARTIFACT_LIMITS.leaseMs+1;return r;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  await processSourceArtifactCompletions(opened.db,clock,slow);
  expect((await opened.db.query('SELECT 1 FROM record_source_artifact_results WHERE artifact_id=$1',[q.session.artifactId])).rows).toHaveLength(0);
  await processSourceArtifactCompletions(opened.db,clock,store);expect((await readSourceArtifactOperation(opened.db,clock,partner(),q.operation.operationId)).state).toBe('succeeded');offset=0;
 });
 it('rejects current credential revocation during copy and never publishes its preserved orphan',async()=>{
  const savedActor=actor;actor=await freshActor();
  const q=await queue(),revoking=new Proxy(store,{get(target,key){if(key==='commitUpload')return async(...args:Parameters<ObjectStore['commitUpload']>)=>{const result=await target.commitUpload(...args);await opened.db.query('UPDATE platform_credentials SET revoked_at=$2 WHERE id=$1',[actor.credentialId,clock.now().toISOString()]);return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  try{await processSourceArtifactCompletions(opened.db,clock,revoking);expect((await opened.db.query('SELECT state FROM record_source_artifact_operations WHERE id=$1',[q.operation.operationId])).rows[0]).toEqual({state:'failed'});expect((await opened.db.query('SELECT 1 FROM record_source_artifact_results WHERE artifact_id=$1',[q.session.artifactId])).rows).toHaveLength(0);}finally{actor=savedActor;}
 });
 it('fences already queued work after pause/resume and checks current location on download and during streaming',async()=>{
  const accepted=await done(),q=await queue();await actOnRecordConnection(opened.db,clock,workspace,account,{action:'pause'},`pause-${++index}`);await actOnRecordConnection(opened.db,clock,workspace,account,{action:'resume'},`resume-${++index}`);
  await processSourceArtifactCompletions(opened.db,clock,store);expect((await opened.db.query('SELECT state,error_code FROM record_source_artifact_operations WHERE id=$1',[q.operation.operationId])).rows[0]).toEqual({state:'failed',error_code:'CONNECTION_CHANGED'});
  const reader=await freshActor(),stream=await readPartnerArtifactOrEvidenceStream(opened.db,clock,store,reader,accepted.session.artifactId);await opened.db.query('UPDATE platform_credentials SET revoked_at=$2 WHERE id=$1',[reader.credentialId,clock.now().toISOString()]);
  await expect(async()=>{for await(const _ of stream.body!){};}).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
 });
 it('enforces cross-tenant, subject ownership and source binding without leaking media or receipts',async()=>{
  const s=await init();const wrong={kind:'partner',partner:{...actor,merchantId:'other-tenant'}} as SourceArtifactActor;
  await expect(readSourceUploadSession(opened.db,clock,wrong,s.sessionId)).rejects.toMatchObject({code:'UPLOAD_NOT_FOUND'});
  await expect(readPartnerArtifactOrEvidenceStream(opened.db,clock,store,{...actor,merchantId:'other-tenant'},s.artifactId)).rejects.toBeInstanceOf(Error);
  await expect(init(png(),{subjectId:otherProof})).rejects.toMatchObject({code:'SUBJECT_NOT_FOUND'});
  await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([png()]),128);await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);
 });
 it('verifies recoverable exact accepted refs and immutable receipts/results',async()=>{
  await done();const snapshot=await buildProofRecoverySnapshot(opened.db,proof) as {rows:Record<string,unknown[]>};
  // Shared recovery integration includes these collections once installed.
  const rows=(snapshot as any).tables??snapshot.rows;
  const artifacts=(await opened.db.query('SELECT * FROM record_source_artifacts WHERE proof_id=$1',[proof])).rows,results=(await opened.db.query('SELECT r.* FROM record_source_artifact_results r JOIN record_source_artifacts a ON a.id=r.artifact_id WHERE a.proof_id=$1',[proof])).rows;
  await verifyRestoredSourceArtifacts(store,{...(rows??{}),record_source_artifacts:artifacts,record_source_artifact_results:results});
  await expect(verifyRestoredSourceArtifacts(store,{record_source_artifacts:artifacts,record_source_artifact_results:results.map((r,i)=>i? r:{...r,sha256:'0'.repeat(64)})})).rejects.toMatchObject({code:'RECOVERY_SOURCE_ARTIFACT_INVALID'});
  await expect(opened.db.query("UPDATE record_source_artifacts SET filename='rewritten' WHERE id=$1",[artifacts[0].id])).rejects.toThrow(/immutable/i);
  await expect(opened.db.query("DELETE FROM record_source_artifact_results WHERE artifact_id=$1",[results[0].artifact_id])).rejects.toThrow(/immutable/i);
  expect((await listSourceArtifacts(opened.db,clock,human,proof)).artifacts.some(a=>a.downloadAvailable)).toBe(true);
 });
 it('does not turn delegated source upload or queued work into a current location grant',async()=>{
  const p=(await createOrganization(opened.db,clock,admin,{kind:'PARTNER',name:'Delegated artifact processor',ownerUserId:admin},'test')).id;await setOrganizationEntitlement(opened.db,clock,admin,p,{enabled:true},'test');
  const principal=await createServicePrincipal(opened.db,clock,admin,p,{name:'Delegated source'},'test'),expiresAt=new Date(Date.now()+86400000).toISOString();
  const credential=await issuePartnerCredential(opened.db,clock,admin,p,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt},'test'),grant=await createDelegation(opened.db,clock,owner,org,{partnerOrganizationId:p,scopes:[...PARTNER_SCOPES],operatorUserIds:[owner],expiresAt},'test');
  const delegated=await authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,grant.id,'test'),a:SourceArtifactActor={kind:'partner',partner:delegated},q=await queue(png(),a);
  const location='artifact-location';await opened.db.query('INSERT INTO record_locations(id,organization_id,name,created_at) VALUES($1,$2,$3,$4)',[location,org,'Private site',clock.now().toISOString()]);
  await opened.db.query('UPDATE record_state SET location_id=$2 WHERE proof_id=$1',[proof,location]);
  try{
   await expect(initializeSourceArtifact(opened.db,clock,a,input(),'located-source')).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
   await processSourceArtifactCompletions(opened.db,clock,store);expect((await opened.db.query('SELECT state,error_code FROM record_source_artifact_operations WHERE id=$1',[q.operation.operationId])).rows[0]).toEqual({state:'failed',error_code:'PROOF_NOT_FOUND'});
   const available=(await listSourceArtifacts(opened.db,clock,human,proof)).artifacts.find(a=>a.downloadAvailable)!;await expect(readPartnerArtifactOrEvidenceStream(opened.db,clock,store,delegated,available.artifactId)).rejects.toMatchObject({code:'PROOF_NOT_FOUND'});
  }finally{await opened.db.query('UPDATE record_state SET location_id=NULL WHERE proof_id=$1',[proof]);}
 });
 it('binds signed artifact pagination to the record and actor and rejects tampering',async()=>{
  vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY',Buffer.alloc(32,7).toString('base64'));
  const first=await listSourceArtifacts(opened.db,clock,human,proof,{limit:2});expect(first.artifacts).toHaveLength(2);expect(first.nextCursor).toBeTypeOf('string');
  const second=await listSourceArtifacts(opened.db,clock,human,proof,{limit:2,cursor:first.nextCursor});expect(second.artifacts.map(r=>r.artifactId)).not.toContain(first.artifacts[0].artifactId);
  await expect(listSourceArtifacts(opened.db,clock,human,otherProof,{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  await expect(listSourceArtifacts(opened.db,clock,partner(),proof,{limit:2,cursor:first.nextCursor})).rejects.toMatchObject({code:'INVALID_CURSOR'});
  await expect(listSourceArtifacts(opened.db,clock,human,proof,{limit:2,cursor:`${first.nextCursor}x`})).rejects.toMatchObject({code:'INVALID_CURSOR'});
 });
 it('requires explicit evidence write and permits exports-read-only download independently',async()=>{
  const expiresAt=new Date(Date.now()+86400000).toISOString();
  async function scoped(scopes:string[]){const credential=await issuePartnerCredential(opened.db,clock,owner,org,actor.principalId,{scopes,expiresAt},'limited-scope');return authenticatePartner(opened.db,clock,`Bearer ${credential.token}`,org,undefined,'limited-scope');}
  const writer=await scoped(['proofs:write']);await expect(initializeSourceArtifact(opened.db,clock,{kind:'partner',partner:writer},input(),'old-write-scope')).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
  const evidenceWriter=await scoped(['evidence:write']),a:SourceArtifactActor={kind:'partner',partner:evidenceWriter},q=await queue(png(),a);await processSourceArtifactCompletions(opened.db,clock,store);expect((await readSourceArtifactOperation(opened.db,clock,a,q.operation.operationId)).state).toBe('succeeded');
  await expect(readPartnerArtifactOrEvidenceStream(opened.db,clock,store,evidenceWriter,q.session.artifactId)).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
  const reader=await scoped(['exports:read']),media=await readPartnerArtifactOrEvidenceStream(opened.db,clock,store,reader,q.session.artifactId),chunks:Buffer[]=[];for await(const b of media.body!)chunks.push(Buffer.from(b));expect(Buffer.concat(chunks)).toEqual(png());
 });
 it('does not replace a received part on retry conflict or admit unlimited ingress',async()=>{
  const original=png(),s=await init(original);await receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([original]),128,1);
  const changed=png();changed[100]=23;await expect(receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([changed]),128,1)).rejects.toMatchObject({code:'UPLOAD_PART_CONFLICT'});
  await expect(receiveSourceArtifactBytes(opened.db,clock,store,partner(),s.sessionId,Readable.from([original]),128,1)).rejects.toMatchObject({code:'UPLOAD_INGRESS_LIMIT'});
  await assembleSourceArtifactParts(opened.db,clock,store,partner(),s.sessionId);const op=await completeSourceArtifact(opened.db,clock,partner(),s.sessionId);await processSourceArtifactCompletions(opened.db,clock,store);expect((await readSourceArtifactOperation(opened.db,clock,partner(),op.operationId)).result?.sha256).toBe(sha256Hex(original));
 });
 it('expires reservations and caps concurrent active source uploads without erasing originals',async()=>{
  const one=await init(png(),{connectionId:undefined},human),two=await init(png(),{connectionId:undefined},human);
  await expect(init(png(),{connectionId:undefined},human)).rejects.toMatchObject({code:'UPLOAD_CONCURRENCY_LIMIT'});
  offset+=SOURCE_ARTIFACT_LIMITS.reservationMs+1;
  expect((await readSourceUploadSession(opened.db,clock,human,one.sessionId)).state).toBe('expired');
  await expect(receiveSourceArtifactBytes(opened.db,clock,store,human,two.sessionId,Readable.from([png()]),128)).rejects.toMatchObject({code:'UPLOAD_EXPIRED'});
 });
});
