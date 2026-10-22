import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { FlattenedSign } from 'jose';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createHarness, createUser, commitFulfillmentAndAttest, auth, type TestHarness } from './helpers.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { openRecipientTestRoles } from './recipient-role-test-database.js';
import { VersionedMemoryObjectStore } from './versioned-memory-object-store.js';
import { createOrganization, setOrganizationEntitlement, addOrganizationMember, createIntegrationAccount, createServicePrincipal,
  issuePartnerCredential, authenticatePartner, PARTNER_SCOPES, revokeOrganizationMember } from '../src/platform/organizations.js';
import { importPartnerOrder } from '../src/platform/partner-proofs.js';
import { withPartnerReadGrant } from '../src/platform/proof-read-grant.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { processRecoveryOutbox, type RecoveryPublisher } from '../src/domain/recovery-journal.js';
import { processPolicyRecoveryOutbox } from '../src/domain/policy-recovery.js';
import { requestProofEnvelope, getProofEnvelope, exportProofEnvelope, assertEnvelopeRequestAuthority, type EnvelopeAccessRuntime } from '../src/integrity/envelope-access.js';
import { processEnvelopeJob, type EnvelopeStore, type EnvelopeWorker } from '../src/integrity/envelope-jobs.js';
import { ENVELOPE_TYPE, jcsBytes, sha256, type ExactObject } from '../src/integrity/envelope-profile.js';
import { collectSmallZip } from '../src/export/zip-stream.js';

const now = new Date('2026-10-22T05:00:00.000Z'), clock = { now: () => new Date(now) }, until = '2027-10-22T05:00:00.000Z';
const keys = generateKeyPairSync('ec', { namedCurve:'prime256v1' }), pem = keys.publicKey.export({ type:'spki',format:'pem' }).toString();

describe('authenticated envelope admission and exact preserved package', () => {
  let h:TestHarness, opened:Awaited<ReturnType<typeof openIsolatedTestDatabase>>, roles:Awaited<ReturnType<typeof openRecipientTestRoles>>;
  let owner:string, seller:string, outsider:string, merchantId:string, membershipId:string, proofId:string, manifestId:string, operationId:string, accountId:string;
  let queuedProofId:string, queuedManifestId:string;
  let partner:Awaited<ReturnType<typeof authenticatePartner>>, token:string;
  let trusted=true, signCalls=0, storageReads=0;
  const objects=new Map<string,{body:Buffer;object:ExactObject}>(), journalObjects=new Map<string,Buffer>();
  const id=(o:ExactObject)=>`${o.bucket}/${o.key}`;
  const exact=(o:ExactObject)=>{storageReads++;const value=objects.get(id(o));if(!value||value.object.versionId!==o.versionId)throw Error('EXACT_VERSION_UNAVAILABLE');return value;};
  const store:EnvelopeStore={find:async(bucket,key)=>objects.get(`${bucket}/${key}`)??null,
    preserve:async(bucket,key,body,retainUntil)=>{if(!objects.has(`${bucket}/${key}`))objects.set(`${bucket}/${key}`,{body:Buffer.from(body),object:{bucket,key,versionId:`version-${objects.size+1}`}});const value=objects.get(`${bucket}/${key}`)!;return store.verify({storage:value.object,sha256:sha256(value.body),byteSize:value.body.length},retainUntil);},
    verify:async(artifact,retainUntil)=>{const saved=exact(artifact.storage);if(sha256(saved.body)!==artifact.sha256||saved.body.length!==artifact.byteSize)throw Error('ENVELOPE_OBJECT_DIGEST_MISMATCH');return {object:saved.object,sha256:artifact.sha256,byteSize:artifact.byteSize,mode:'COMPLIANCE',retainUntil,verifiedAt:now.toISOString()};}};
  const journal={putIfAbsent:async(key:string,body:Buffer)=>{if(journalObjects.has(key))return {created:false};journalObjects.set(key,Buffer.from(body));return {created:true};},
    get:async(key:string,reference?:{versionId:string})=>{const body=journalObjects.get(key);if(reference&&reference.versionId!==`journal-${body&&sha256(body)}`)throw Error('JOURNAL_VERSION');return body?{body,contentType:'application/json'}:null;},
    head:async(key:string)=>{const body=journalObjects.get(key);return body?{versionId:`journal-${sha256(body)}`}:null;}};
  const publisher:RecoveryPublisher={store:journal,protectedStoreVerified:true,writerGeneration:'initial',trustedPublicKey:async key=>key==='journal-key'?pem:null,
    signer:{signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'journal-key',signedAt:now.toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),keys.privateKey).toString('base64')})}};
  const runtime:EnvelopeAccessRuntime={assertReady:()=>{},cohort:{merchantIds:[],environment:'sandbox',cutoverAt:now.toISOString()},
    admission:{evidenceBucket:'originals',artifactBucket:'envelopes',issuer:'https://envelopes.example.test',keyId:'envelope-key',retainUntil:until,writerGeneration:'initial'},
    reader:{verify:store.verify,readExact:async(object,maximum)=>{const value=exact(object);if(value.body.length>maximum)throw Error('BOUND');return {body:Buffer.from(value.body),versionId:value.object.versionId};},openExact:async object=>{const value=exact(object);return {body:Readable.from([value.body]),versionId:value.object.versionId};}},
    sourceJournal:publisher,trustedPublicKey:async(issuer,key)=>trusted&&issuer==='https://envelopes.example.test'&&key==='envelope-key'?pem:null};
  const worker:EnvelopeWorker={writerGeneration:'initial',store,sourceJournal:publisher,trustedPublicKey:runtime.trustedPublicKey,
    sign:async(kid,bytes)=>{signCalls++;return new FlattenedSign(bytes).setProtectedHeader(JSON.parse(jcsBytes({alg:'ES256',kid,typ:ENVELOPE_TYPE}).toString())).sign(keys.privateKey);},
    authorizeRequest:(db,op,record)=>assertEnvelopeRequestAuthority(db,runtime,op,record)};
  const input=()=>({recordType:'CORE',recordId:manifestId});
  const endpoint=()=>`/proofs/${proofId}/integrity-envelopes`;
  async function drain(){
    for(let i=0;i<100;i++){const r=await processPolicyRecoveryOutbox(roles?.worker??h.db,clock,publisher);if(!r.processed)break;expect(r.state).toBe('DURABLE');}
    for(let i=0;i<100;i++){const r=await processRecoveryOutbox(roles?.worker??h.db,clock,publisher);if(!r.processed)return;if(r.state!=='DURABLE')throw Error(JSON.stringify((await h.db.query("SELECT operation_id,state,error_code FROM recovery_delivery WHERE state<>'DURABLE'")).rows));}
    throw Error('Journal did not drain');
  }
  beforeAll(async()=>{
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED','true');
    opened=await openIsolatedTestDatabase();h=await createHarness(clock,{opened,objectStore:new VersionedMemoryObjectStore(),envelopes:runtime});
    const admin=await createUser(h);owner=await createUser(h);seller=await createUser(h);outsider=await createUser(h);
    await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')",[admin,now.toISOString()]);
    const organization=await createOrganization(h.db,clock,admin,{kind:'MERCHANT',name:'Synthetic envelope cohort',ownerUserId:owner},'fixture');merchantId=organization.id;
    await setOrganizationEntitlement(h.db,clock,admin,merchantId,{enabled:true},'fixture');
    membershipId=(await addOrganizationMember(h.db,clock,owner,merchantId,{userId:seller,role:'OPERATOR'},'fixture')).id;
    const account=await createIntegrationAccount(h.db,clock,owner,merchantId,{provider:'reference',externalAccountId:'synthetic-envelope-account'},'fixture');
    accountId=account.id;
    const principal=await createServicePrincipal(h.db,clock,owner,merchantId,{name:'Synthetic envelope reader'},'fixture');
    const credential=await issuePartnerCredential(h.db,clock,owner,merchantId,principal.id,{scopes:[...PARTNER_SCOPES],expiresAt:'2026-10-23T05:00:00.000Z'},'fixture');token=credential.token;
    partner=await authenticatePartner(h.db,clock,`Bearer ${token}`,merchantId,undefined,'fixture');
    proofId=(await importPartnerOrder(h.db,clock,partner,{integrationAccountId:account.id,externalId:'synthetic-order',operatorMembershipId:membershipId,transaction:{itemTitle:'Synthetic frozen original'}})).proofId;
    runtime.cohort.merchantIds=[merchantId];
    await commitFulfillmentAndAttest(h,seller,proofId);await drain();
    await finalizeProof(h.db,clock,seller,proofId,publisher.signer,{requireDurableReceipts:true});await drain();
    const frozen=(await h.db.query<{id:string;canonical_json:string}>('SELECT id,canonical_json FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0];manifestId=frozen.id;
    for(const media of JSON.parse(frozen.canonical_json).evidence){const stored=await h.objectStore.get(media.objectKey,{versionId:media.objectVersionId});objects.set(`originals/${media.objectKey}`,{body:stored!.body,object:{bucket:'originals',key:media.objectKey,versionId:media.objectVersionId}});}
    // Prepare both finalized sources under the owner fixture controller. These
    // narrow M2 test roles do not define the M1 finalization/outbox grant policy.
    queuedProofId=(await importPartnerOrder(h.db,clock,partner,{integrationAccountId:accountId,externalId:'queued-before-revocation',operatorMembershipId:membershipId,transaction:{itemTitle:'Synthetic queued original'}})).proofId;
    await commitFulfillmentAndAttest(h,seller,queuedProofId);await drain();
    await finalizeProof(h.db,clock,seller,queuedProofId,publisher.signer,{requireDurableReceipts:true});await drain();
    queuedManifestId=(await h.db.query<{id:string}>('SELECT id FROM final_manifests WHERE proof_id=$1',[queuedProofId])).rows[0].id;
    roles=await openRecipientTestRoles(h.db);
    // Additional synthetic baseline column locks needed by delegated read reauthorization.
    // This fixture grant is not a production baseline privilege policy.
    await h.db.query(`GRANT UPDATE(id) ON platform_credentials,platform_principals,platform_delegations TO "${roles.apiRole}"`);
  },60000);
  afterAll(async()=>{await roles?.close();await h?.close();await opened?.close();vi.unstubAllEnvs();});

  it('requires authentication and rejects forged scope, cross-Proof source and out-of-cohort admission',async()=>{
    const contract=await request(h.app).get('/v1/envelope-openapi.json');expect(contract.status).toBe(200);expect(contract.body.paths['/proofs/{id}/integrity-envelopes'].post.operationId).toBe('requestIntegrityEnvelope');
    const ready=runtime.assertReady;runtime.assertReady=()=>{throw Error('Expired deployment evidence');};
    expect((await request(h.app).post(endpoint()).set(auth(seller)).send(input())).status).toBe(503);runtime.assertReady=ready;
    expect((await request(h.app).post(endpoint()).send(input())).status).toBe(401);
    expect((await request(h.app).post(endpoint()).set(auth(outsider)).send(input())).status).toBe(403);
    expect((await request(h.app).post(endpoint()).set(auth(seller)).send({...input(),artifactBucket:'attacker'})).status).toBe(400);
    await expect(requestProofEnvelope(roles.api,clock,seller,proofId,{recordType:'CORE',recordId:'wrong-record'},runtime)).rejects.toMatchObject({httpStatus:404});
    runtime.cohort.merchantIds=[];await expect(requestProofEnvelope(roles.api,clock,seller,proofId,input(),runtime)).rejects.toMatchObject({httpStatus:404});runtime.cohort.merchantIds=[merchantId];
    runtime.cohort.cutoverAt='2026-10-22T05:00:01.000Z';await expect(requestProofEnvelope(roles.api,clock,seller,proofId,input(),runtime)).rejects.toMatchObject({code:'ENVELOPE_SOURCE_UNAVAILABLE'});runtime.cohort.cutoverAt=now.toISOString();
    expect(signCalls).toBe(0);expect(storageReads).toBe(0);
  });
  it('queues idempotently using the API role, records the human caller and refuses premature downloads',async()=>{
    const first=await requestProofEnvelope(roles.api,clock,seller,proofId,input(),runtime);operationId=first.operationId;expect(first.state).toBe('PENDING');
    const replay=await request(h.app).post(endpoint()).set(auth(seller)).send(input());expect(replay.status).toBe(202);expect(replay.body).toMatchObject({operationId,replayed:true});
    const key=runtime.admission.keyId;runtime.admission.keyId='changed-policy-key';
    const conflict=await request(h.app).post(endpoint()).set(auth(seller)).send(input());expect(conflict.status).toBe(409);runtime.admission.keyId=key;
    const audit=(await h.db.query<{actor_user_id:string}>("SELECT actor_user_id FROM audit_events WHERE proof_id=$1 AND event_type='ENVELOPE_SIGNING_REQUESTED'",[proofId])).rows;
    expect(audit).toEqual([{actor_user_id:seller}]);
    expect((await request(h.app).get(`${endpoint()}/${operationId}/package`).set(auth(seller))).status).toBe(409);
    expect(await processEnvelopeJob(roles.worker,clock,worker)).toEqual({processed:0});expect(signCalls).toBe(0);
    await expect(roles.api.query("UPDATE integrity_envelope_delivery SET state='ACCEPTED'")).rejects.toThrow();
  });
  it('exposes READY only after result preservation and exports without another signature',async()=>{
    await drain();expect(await processEnvelopeJob(roles.worker,clock,worker)).toEqual({processed:1,state:'SIGNED_PENDING_DURABILITY'});
    expect((await getProofEnvelope(roles.api,seller,proofId,operationId,runtime)).state).toBe('SIGNED_PENDING_DURABILITY');
    await expect(exportProofEnvelope(roles.api,seller,proofId,operationId,runtime)).rejects.toMatchObject({code:'ENVELOPE_NOT_READY'});
    await drain();expect((await getProofEnvelope(roles.api,seller,proofId,operationId,runtime)).state).toBe('READY');
    const archive=await collectSmallZip(await exportProofEnvelope(roles.api,seller,proofId,operationId,runtime));
    expect(archive.subarray(-22).readUInt32LE(0)).toBe(0x06054b50);expect(archive.includes(Buffer.from('integrity/envelope.jws.json'))).toBe(true);
    const download=await request(h.app).get(`${endpoint()}/${operationId}/package`).set(auth(seller));expect(download.status).toBe(200);expect(download.headers['content-type']).toContain('application/zip');
    expect(signCalls).toBe(1);
  });
  it('permits current scoped partner reads but refuses service-principal admission',async()=>{
    const db=withPartnerReadGrant(roles.api,clock,partner,proofId,'exports:read');
    expect((await getProofEnvelope(db,partner.actorUserId,proofId,operationId,runtime)).state).toBe('READY');
    await expect(requestProofEnvelope(db,clock,partner.actorUserId,proofId,input(),runtime)).rejects.toMatchObject({code:'HUMAN_AUTHENTICATION_REQUIRED'});
    const response=await request(h.app).get(`/v1/partner/proofs/${proofId}/integrity-envelopes/${operationId}`).set('Authorization',`Bearer ${token}`).set('PackProof-Merchant-Id',merchantId);
    expect(response.status).toBe(200);expect(response.body.state).toBe('READY');
  });
  it('denies cross-Proof status and never falls back to another stored version',async()=>{
    await expect(getProofEnvelope(roles.api,outsider,proofId,operationId,runtime)).rejects.toMatchObject({httpStatus:403});
    const read=runtime.reader.readExact;runtime.reader.readExact=async(o,max)=>({...await read(o,max),versionId:'substituted-version'});
    await expect(exportProofEnvelope(roles.api,seller,proofId,operationId,runtime)).rejects.toMatchObject({code:'ENVELOPE_INTEGRITY_FAILURE'});runtime.reader.readExact=read;
    expect(signCalls).toBe(1);
  });
  it('prevents a complete archive when the signing key becomes untrusted mid-response',async()=>{
    const stream=await exportProofEnvelope(roles.api,seller,proofId,operationId,runtime),parts:Buffer[]=[];
    await expect((async()=>{for await(const part of stream){parts.push(Buffer.from(part));trusted=false;}})()).rejects.toThrow();
    trusted=true;expect(Buffer.concat(parts).includes(Buffer.from([0x50,0x4b,0x05,0x06]))).toBe(false);
  });
  it('checks completed membership revocation on status, replay and an already-open download',async()=>{
    await requestProofEnvelope(roles.api,clock,seller,queuedProofId,{recordType:'CORE',recordId:queuedManifestId},runtime);await drain();
    const stream=await exportProofEnvelope(roles.api,seller,proofId,operationId,runtime),parts:Buffer[]=[];let revoked=false;
    await expect((async()=>{for await(const part of stream){parts.push(Buffer.from(part));if(!revoked){revoked=true;await revokeOrganizationMember(h.db,clock,owner,merchantId,membershipId,'fixture');await drain();}}})()).rejects.toThrow();
    expect(Buffer.concat(parts).includes(Buffer.from([0x50,0x4b,0x05,0x06]))).toBe(false);
    await expect(getProofEnvelope(roles.api,seller,proofId,operationId,runtime)).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
    await expect(requestProofEnvelope(roles.api,clock,seller,proofId,input(),runtime)).rejects.toMatchObject({code:'ORGANIZATION_ACCESS_REVOKED'});
    const stored=(await h.db.query<{request_json:string}>('SELECT request_json FROM integrity_envelope_jobs WHERE operation_id=$1',[operationId])).rows[0];
    await expect(assertEnvelopeRequestAuthority(roles.worker,runtime,operationId,JSON.parse(stored.request_json))).rejects.toThrow('ENVELOPE_AUTHORIZATION_REVOKED');
    const reads=storageReads;
    expect(await processEnvelopeJob(roles.worker,clock,worker)).toEqual({processed:1,state:'DEAD_LETTER'});
    expect(storageReads).toBe(reads);
    expect(signCalls).toBe(1);
  });
});
