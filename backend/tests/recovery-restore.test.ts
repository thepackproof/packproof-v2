import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { migrate } from "../src/db/migrate.js";
import type { Database } from "../src/db/database.js";
import { createHarness, createUser, commitFulfillmentAndAttest, commitProofEvidence, prepareCameraCapture } from "./helpers.js";
import { createTransaction } from "../src/domain/transactions.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { getRecoveryStatus, processRecoveryOutbox, type RecoveryPublisher } from "../src/domain/recovery-journal.js";
import { assertPolicyAccessSafe, inspectPolicyRecoveryReconciliation, processPolicyRecoveryOutbox } from "../src/domain/policy-recovery.js";
import { restoreFreshRecoveryDatabase, type FreshRecoveryRestoreInput } from "../src/domain/recovery-restore.js";
import { LocalObjectStore } from "../src/s3/local-object-store.js";
import { createAccessLink, revokeAccessLink } from "../src/domain/access-links.js";
import { inviteCommerceReceiver, acceptCommerceReceiver, createCommerceStage, initializeStageEvidence, commitStageEvidence, finalizeCommerceStage } from "../src/domain/commerce-lifecycle.js";
import { appendProofSupplement } from "../src/domain/proof-supplements.js";
import { sha256Hex } from "../src/hash.js";
import { canonicalize } from "../src/canonical.js";
import { createAttestationChallenge, verifyAttestationAuthorization } from "../src/domain/attestation-authorization.js";
import { commitAttestation } from "../src/domain/attestations.js";
import type { EvidenceRow } from "../src/domain/types.js";

const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),pem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
const clock={now:()=>new Date('2026-09-07T12:00:00Z')};
class ProtectedJournal {
  objects=new Map<string,Buffer>();
  async putIfAbsent(key:string,bytes:Buffer){if(this.objects.has(key))return {created:false};this.objects.set(key,bytes);return {created:true};}
  async get(key:string){const body=this.objects.get(key);return body?{body,contentType:'application/json'}:null;}
  async head(key:string){return this.objects.has(key)?{versionId:'protected-test-version',byteSize:this.objects.get(key)!.length,contentType:'application/json'}:null;}
}
describe('fresh isolated accepted-record reconstruction',()=>{
  const cleanups:Array<()=>Promise<void>>=[];
  function cleanup(fn:()=>Promise<void>){let done=false;const close=async()=>{if(!done){done=true;await fn();}};cleanups.push(close);return close;}
  afterEach(async()=>{for(const close of cleanups.reverse())await close();cleanups.length=0;});
  async function target(dir?:string){
    const opened=await createPgliteDatabase(dir);cleanup(opened.close);await migrate(opened.db);
    return opened;
  }
  async function assumeRestoreRole(db:Database){
    await db.query('CREATE ROLE packproof_restore NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await db.query('GRANT USAGE ON SCHEMA public TO packproof_restore');
    await db.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO packproof_restore');
    await db.query('GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO packproof_restore');
    await db.query('SET ROLE packproof_restore');
    return (await db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
  }
  async function source(withStaleBackup=false){
    const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-actual-replay-'));cleanup(()=>rm(dir,{recursive:true,force:true}));
    const media=new LocalObjectStore(path.join(dir,'media'),'http://test','test');
    let opened=await createPgliteDatabase(path.join(dir,'live'));let closeOpened=cleanup(opened.close);
    let h=await createHarness(clock,{opened,objectStore:media});let closeHarness=cleanup(h.close);
    const seller=await createUser(h),transaction=await createTransaction(h.db,clock,seller,{itemTitle:'Acknowledged after backup'}),proof=await createOrGetProof(h.db,clock,seller,transaction.transactionId);
    const journal=new ProtectedJournal(),publisher:RecoveryPublisher={store:journal,protectedStoreVerified:true,writerGeneration:'initial',trustedPublicKey:async id=>id==='restore-test-key'?pem:null,signer:{signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'restore-test-key',signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),keys.privateKey).toString('base64')})}};
    const drain=async()=>{for(let i=0;i<100;i++)if(!(await processPolicyRecoveryOutbox(h.db,clock,publisher)).processed)return;throw new Error('Policy queue did not drain');};
    const link=await createAccessLink(h.db,clock,seller,proof.proofId,{scope:'SUMMARY',publicWebBaseUrl:'https://test'});await drain();
    if(withStaleBackup){await closeHarness();await closeOpened();await cp(path.join(dir,'live'),path.join(dir,'stale'),{recursive:true});opened=await createPgliteDatabase(path.join(dir,'live'));closeOpened=cleanup(opened.close);h=await createHarness(clock,{opened,objectStore:media});closeHarness=cleanup(h.close);}
    const evidence=withStaleBackup?await commitProofEvidence(h,seller,proof.proofId,{evidenceType:'FULFILLMENT_CAPTURE'}):await commitFulfillmentAndAttest(h,seller,proof.proofId);
    let nativeAuthorization:{challengeId:string;signature:string}|undefined;
    if(withStaleBackup){
      const session=(await h.db.query<{capture_session_id:string}>('SELECT capture_session_id FROM evidence WHERE id=$1',[evidence.evidenceId])).rows[0].capture_session_id;
      const challenge=await createAttestationChallenge(h.db,clock,seller,proof.proofId,{captureSessionId:session,sha256:evidence.sha256,publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')});
      nativeAuthorization={challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.payload),keys.privateKey).toString('base64')};
      await commitAttestation(h.db,clock,seller,proof.proofId,{statement:'PACKED_DESCRIBED_ITEM',relatedEvidenceId:evidence.evidenceId,authorization:nativeAuthorization});
    }
    await drain();await processRecoveryOutbox(h.db,clock,publisher);await processRecoveryOutbox(h.db,clock,publisher);
    await finalizeProof(h.db,clock,seller,proof.proofId,publisher.signer,{requireDurableReceipts:true});
    await processRecoveryOutbox(h.db,clock,publisher);
    const acknowledged=await finalizeProof(h.db,clock,seller,proof.proofId,publisher.signer,{requireDurableReceipts:true});
    expect(acknowledged.proof.status).toBe('FINALIZED');
    const acceptedAuditRows=(await h.db.query('SELECT to_jsonb(t) AS row FROM audit_events t ORDER BY id')).rows;
    await revokeAccessLink(h.db,clock,seller,proof.proofId,link.accessLinkId);await drain();
    const core=[...journal.objects].filter(([key])=>key.startsWith('recovery/v1/')).map(([,body])=>body);
    const policy=[...journal.objects].filter(([key])=>key.startsWith('recovery/policy/v1/')).map(([,body])=>body);
    const input:FreshRecoveryRestoreInput={expectedDatabase:'',restoreRole:'packproof_restore',isolatedTargetReference:'test-isolated-target',oldWriterFenceReference:'test-external-fence-reference',targetWriterGeneration:'replacement-test',core:{envelopes:core,expectedWatermark:core.at(-1)!},policy:{envelopes:policy,expectedWatermark:policy.at(-1)!},trustedPublicKey:publisher.trustedPublicKey,sourceStore:{get:(key,ref)=>key.startsWith('recovery/')?journal.get(key):media.get(key,ref),head:(key,ref)=>key.startsWith('recovery/')?journal.head(key):media.head(key,ref),getStream:media.getStream.bind(media)}};
    return {h,dir,evidence,seller,publisher,drain,nativeAuthorization,proofId:proof.proofId,input,acknowledged,acceptedAuditRows,link,journal};
  }
  it('rejects an older disk backup as a target and reconstructs the acknowledged final record in a new fenced database',async()=>{
    const fixture=await source(true),stale=await target(path.join(fixture.dir,'stale'));
    expect((await stale.db.query<{status:string}>('SELECT status FROM proofs WHERE id=$1',[fixture.proofId])).rows[0].status).not.toBe('FINALIZED');
    fixture.input.expectedDatabase=await assumeRestoreRole(stale.db);
    await expect(restoreFreshRecoveryDatabase(stale.db,fixture.input)).rejects.toMatchObject({code:'RECOVERY_RESTORE_TARGET_NOT_EMPTY'});
    const fresh=await target(path.join(fixture.dir,'restored'));fixture.input.expectedDatabase=await assumeRestoreRole(fresh.db);
    const report=await restoreFreshRecoveryDatabase(fresh.db,fixture.input);
    expect(report).toMatchObject({trafficMayOpen:false,writersEnabled:false,media:{objects:1,exactVersionsVerified:true},counts:{recovery_events:3,recovery_delivery:3,final_manifests:1}});
    const restored=(await fresh.db.query<{status:string;manifest_id:string}>('SELECT status,manifest_id FROM proofs WHERE id=$1',[fixture.proofId])).rows[0];
    expect(restored).toEqual({status:'FINALIZED',manifest_id:fixture.acknowledged.manifest.manifestId});
    const manifest=(await fresh.db.query<{canonical_json:string;sha256:string}>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1',[fixture.proofId])).rows[0];
    expect(manifest.canonical_json).toBe(fixture.acknowledged.manifest.canonicalJson);expect(manifest.sha256).toBe(fixture.acknowledged.manifest.sha256);
    for(const table of ['evidence','audit_events','attestation_challenges','recovery_events']){
      const query=`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${table==='recovery_events'?'sequence':'id'}`;
      expect((await fresh.db.query(query)).rows).toEqual(table==='audit_events'?fixture.acceptedAuditRows:(await fixture.h.db.query(query)).rows);
    }
    expect(await getRecoveryStatus(fresh.db,`finalize:${fixture.proofId}`)).toEqual(await getRecoveryStatus(fixture.h.db,`finalize:${fixture.proofId}`));
    const restoredEvidence=(await fresh.db.query<EvidenceRow>('SELECT * FROM evidence WHERE id=$1',[fixture.evidence.evidenceId])).rows[0];
    // Check the signed challenge recovery primitive under the still-closed target;
    // public request authorization remains fenced until an independent cutover.
    const retry=await fresh.db.transaction(tx=>verifyAttestationAuthorization(tx,{now:()=>new Date('2026-10-01')},fixture.seller,fixture.proofId,fixture.nativeAuthorization,restoredEvidence));
    expect(retry.attestationId).toBe((await fresh.db.query('SELECT id FROM attestations WHERE proof_id=$1',[fixture.proofId])).rows[0].id);
    expect((await fresh.db.query('SELECT revoked_at FROM proof_access_links WHERE id=$1',[fixture.link.accessLinkId])).rows[0].revoked_at).toBeTruthy();
    expect((await inspectPolicyRecoveryReconciliation(fresh.db)).matches).toBe(true);
    await expect(assertPolicyAccessSafe(fresh.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
    expect((await fresh.db.query('SELECT writes_enabled,generation FROM recovery_writer_fence')).rows[0]).toEqual({writes_enabled:false,generation:'replacement-test'});
    await expect(fresh.db.query("UPDATE evidence SET sha256='changed' WHERE id=$1",[fixture.evidence.evidenceId])).rejects.toThrow('EVIDENCE_ALREADY_COMMITTED');
    await expect(fresh.db.query("UPDATE final_manifests SET canonical_json='{}'")).rejects.toThrow('MANIFEST_IMMUTABLE');
  },30000);
  it('requires dedicated restore authority and an independently supplied latest signed head',async()=>{
    const fixture=await source(),fresh=await target();
    fixture.input.expectedDatabase=(await fresh.db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
    await expect(restoreFreshRecoveryDatabase(fresh.db,fixture.input)).rejects.toMatchObject({code:'RECOVERY_RESTORE_AUTHORITY_REQUIRED'});
    await assumeRestoreRole(fresh.db);
    await expect(restoreFreshRecoveryDatabase(fresh.db,{...fixture.input,core:{...fixture.input.core,expectedWatermark:fixture.input.core.envelopes[0]}})).rejects.toMatchObject({code:'RECOVERY_RESTORE_HEAD_MISMATCH'});
    expect((await fresh.db.query('SELECT * FROM proofs')).rows).toHaveLength(0);
    await expect(assertPolicyAccessSafe(fresh.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
  },30000);
  it('keeps corrupt or unavailable exact media from producing any restored accepted record',async()=>{
    const fixture=await source(),fresh=await target();fixture.input.expectedDatabase=await assumeRestoreRole(fresh.db);
    await expect(restoreFreshRecoveryDatabase(fresh.db,{...fixture.input,sourceStore:{...fixture.input.sourceStore,getStream:async()=>null}})).rejects.toMatchObject({code:'RECOVERY_MEDIA_UNAVAILABLE'});
    expect((await fresh.db.query('SELECT * FROM proofs')).rows).toHaveLength(0);
    expect((await fresh.db.query('SELECT * FROM recovery_events')).rows).toHaveLength(0);
    expect((await fresh.db.query('SELECT writes_enabled FROM recovery_writer_fence')).rows[0].writes_enabled).toBe(false);
  },30000);
  it('restores an unrelated unfinished Proof from signed policy parent context without inventing accepted core receipts',async()=>{
    const fixture=await source(),fresh=await target();
    const transaction=await createTransaction(fixture.h.db,clock,fixture.seller,{itemTitle:'Unfinished draft context'});
    const draft=await createOrGetProof(fixture.h.db,clock,fixture.seller,transaction.transactionId);
    await fixture.drain();
    const policy=[...fixture.journal.objects].filter(([key])=>key.startsWith('recovery/policy/v1/')).map(([,bytes])=>bytes);
    const expectedDatabase=await assumeRestoreRole(fresh.db);
    const report=await restoreFreshRecoveryDatabase(fresh.db,{...fixture.input,expectedDatabase,policy:{envelopes:policy,expectedWatermark:policy.at(-1)!}});
    expect(report.contextOnlyProofIds).toEqual([draft.proofId]);
    expect((await fresh.db.query('SELECT status,manifest_id FROM proofs WHERE id=$1',[draft.proofId])).rows[0]).toEqual({status:draft.status,manifest_id:null});
    expect((await fresh.db.query('SELECT * FROM recovery_events WHERE proof_id=$1',[draft.proofId])).rows).toHaveLength(0);
    expect((await fresh.db.query('SELECT item_title FROM transactions WHERE id=$1',[transaction.transactionId])).rows[0].item_title).toBe('Unfinished draft context');
    expect((await inspectPolicyRecoveryReconciliation(fresh.db)).matches).toBe(true);
    expect((await fresh.db.query('SELECT canonical_json FROM final_manifests WHERE proof_id=$1',[fixture.proofId])).rows[0].canonical_json).toBe(fixture.acknowledged.manifest.canonicalJson);
    await expect(assertPolicyAccessSafe(fresh.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
  },30000);
  it('keeps historical signed policies with missing parent context explicitly closed',async()=>{
    const fixture=await source(),fresh=await target();
    const transaction=await createTransaction(fixture.h.db,clock,fixture.seller,{itemTitle:'Pre-context draft'});
    await createOrGetProof(fixture.h.db,clock,fixture.seller,transaction.transactionId);await fixture.drain();
    // Produce authentic legacy schema envelopes with the fixture authority.
    // Historical policy events did not contain recoveryContext at all.
    const policy:Buffer[]=[];let previousSha256:string|null=null;
    for(const [key,bytes] of fixture.journal.objects){
      if(!key.startsWith('recovery/policy/v1/'))continue;
      const outer=JSON.parse(bytes.toString()),event=JSON.parse(outer.eventCanonicalJson);delete event.change.recoveryContext;event.previousSha256=previousSha256;
      const eventCanonicalJson=canonicalize(event),eventSha256=sha256Hex(eventCanonicalJson);
      const facts={version:outer.version,domain:outer.domain,eventCanonicalJson,eventSha256,publishedAt:outer.publishedAt};
      const canonicalJson=canonicalize(facts),signature=await fixture.publisher.signer.signManifest({proofId:'policy',manifestId:'legacy-fixture',canonicalJson,sha256:sha256Hex(canonicalJson)});
      const legacy=Buffer.from(canonicalize({...facts,signature}));policy.push(legacy);fixture.journal.objects.set(key,legacy);previousSha256=eventSha256;
    }
    const expectedDatabase=await assumeRestoreRole(fresh.db);
    await expect(restoreFreshRecoveryDatabase(fresh.db,{...fixture.input,expectedDatabase,policy:{envelopes:policy,expectedWatermark:policy.at(-1)!}})).rejects.toMatchObject({code:'RECOVERY_RESTORE_DEPENDENCY_GAP'});
    expect((await fresh.db.query('SELECT * FROM proofs')).rows).toHaveLength(0);
    expect((await fresh.db.query('SELECT * FROM recovery_events')).rows).toHaveLength(0);
    await expect(assertPolicyAccessSafe(fresh.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
  },30000);
  it('restores finalized recipient-stage dependencies and signed supplement history without rewriting the frozen seller core',async()=>{
    const fixture=await source(),{h,proofId,seller,publisher}=fixture,receiver=await createUser(h);
    await inviteCommerceReceiver(h.db,clock,seller,proofId,receiver);await acceptCommerceReceiver(h.db,clock,receiver,proofId);
    const stage=await createCommerceStage(h.db,clock,receiver,proofId,'RECEIPT');
    const capture=await prepareCameraCapture(h,receiver,proofId,'restore-stage-camera',stage.stageId);
    const upload=await initializeStageEvidence(h.db,clock,h.objectStore,receiver,proofId,stage.stageId,{contentType:'video/mp4',idempotencyKey:'restore-stage-upload',captureSessionId:capture.captureSessionId});
    const staging=(await h.db.query<{object_key:string}>('SELECT object_key FROM commerce_stage_evidence WHERE id=$1',[upload.evidenceId])).rows[0].object_key;
    await h.objectStore.put(staging,capture.bytes,'video/mp4');
    await commitStageEvidence(h.db,clock,h.objectStore,receiver,proofId,stage.stageId,upload.evidenceId,sha256Hex(capture.bytes));
    await fixture.drain();await processRecoveryOutbox(h.db,clock,publisher);
    await finalizeCommerceStage(h.db,clock,receiver,proofId,stage.stageId,stage.attestation,publisher.signer,{requireDurableReceipts:true});
    await appendProofSupplement(h.db,clock,publisher.signer,seller,proofId,{operationId:'restored:correction',kind:'CORRECTION',facts:{note:'Accepted additional context'}});
    await fixture.drain();for(let i=0;i<10;i++)if(!(await processRecoveryOutbox(h.db,clock,publisher)).processed)break;
    const core=[...fixture.journal.objects].filter(([key])=>key.startsWith('recovery/v1/')).map(([,bytes])=>bytes),policy=[...fixture.journal.objects].filter(([key])=>key.startsWith('recovery/policy/v1/')).map(([,bytes])=>bytes);
    const fresh=await target();const expectedDatabase=await assumeRestoreRole(fresh.db);
    const report=await restoreFreshRecoveryDatabase(fresh.db,{...fixture.input,expectedDatabase,core:{envelopes:core,expectedWatermark:core.at(-1)!},policy:{envelopes:policy,expectedWatermark:policy.at(-1)!}});
    expect(report.media.objects).toBe(2);
    for(const table of ['commerce_receivers','commerce_stages','commerce_stage_evidence','capture_sessions','proof_supplements','proof_supplement_heads']){
      const sql=`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`;
      expect((await fresh.db.query(sql)).rows).toEqual((await h.db.query(sql)).rows);
    }
    expect((await fresh.db.query('SELECT canonical_json FROM final_manifests WHERE proof_id=$1',[proofId])).rows[0].canonical_json).toBe(fixture.acknowledged.manifest.canonicalJson);
    await expect(fresh.db.query('UPDATE commerce_stage_evidence SET sha256=$2 WHERE id=$1',[upload.evidenceId,'a'.repeat(64)])).rejects.toThrow('COMMERCE_STAGE_IMMUTABLE');
  },30000);
});
