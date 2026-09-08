import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createUser, type TestHarness } from "./helpers.js";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { createTransaction } from "../src/domain/transactions.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { createAccessLink, resolveAccessToken, revokeAccessLink } from "../src/domain/access-links.js";
import { resolveDisclosureContext } from "../src/domain/disclosure.js";
import { CognitoJwtAdapter, type CognitoTokenClaims } from "../src/auth/cognito-adapter.js";
import { requireParticipant } from "../src/domain/proof-access.js";
import { processPolicyRecoveryOutbox, configurePolicyDurability, assertPolicyAccessSafe, installPolicyRecoveryReplay, inspectPolicyRecoveryReconciliation, completePolicyRecoveryReconciliation } from "../src/domain/policy-recovery.js";
import { enqueueRecoveryEvent, processRecoveryOutbox, getRecoveryStatus, type RecoveryPublisher } from "../src/domain/recovery-journal.js";

const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),pem=key.publicKey.export({type:"spki",format:"pem"}).toString();
let now=new Date("2026-09-07T12:00:00Z");
const clock={now:()=>new Date(now)};
class Store {
  objects=new Map<string,Buffer>(); loseOnce=false;
  async putIfAbsent(key:string,body:Buffer){if(this.objects.has(key))return {created:false};this.objects.set(key,body);if(this.loseOnce){this.loseOnce=false;throw new Error('response lost');}return {created:true};}
  async get(key:string){const body=this.objects.get(key);return body?{body,contentType:'application/json'}:null;}
  async head(key:string){return this.objects.has(key)?{versionId:'protected-policy-test-version'}:null;}
}
const publisherFor=(store:Store):RecoveryPublisher=>({store,protectedStoreVerified:true,writerGeneration:'initial',trustedPublicKey:async id=>id==='policy-test-key'?pem:null,signer:{signManifest:async input=>({algorithm:'ECDSA_SHA_256',keyId:'policy-test-key',signedAt:clock.now().toISOString(),signatureBase64:sign('sha256',Buffer.from(input.canonicalJson),key.privateKey).toString('base64')})}});
describe('ordered account and disclosure policy recovery',()=>{
  const cleanups:Array<()=>Promise<void>>=[];
  function cleanup(fn:()=>Promise<void>){let closed=false;const once=async()=>{if(!closed){closed=true;await fn();}};cleanups.push(once);return once;}
  afterEach(async()=>{for(const close of cleanups.reverse())await close();cleanups.length=0;now=new Date('2026-09-07T12:00:00Z');});
  async function setup(opened?:Awaited<ReturnType<typeof createPgliteDatabase>>){const h=await createHarness(clock,{opened});const close=cleanup(h.close);const seller=await createUser(h);const transaction=await createTransaction(h.db,clock,seller,{itemTitle:'Policy fixture'});const proof=await createOrGetProof(h.db,clock,seller,transaction.transactionId);return {h,seller,proofId:proof.proofId,close};}
  async function drain(h:TestHarness,publisher:RecoveryPublisher){for(let i=0;i<100;i++){const result=await processPolicyRecoveryOutbox(h.db,clock,publisher);if(!result.processed)return;if(result.state==='DEAD_LETTER')throw new Error('Unexpected policy dead letter');}throw new Error('Policy drain bound exceeded');}
  it('allows strict authenticated requests with unchanged verified claims and publishes actual contact changes',async()=>{
    const h=await createHarness(clock);cleanup(h.close);const store=new Store(),publisher=publisherFor(store);
    let claims:CognitoTokenClaims={sub:'strict-cognito',iss:'fixture',exp:Math.floor(now.getTime()/1000)+3600,token_use:'id',email:'Seller@Example.test',email_verified:true};
    const adapter=new CognitoJwtAdapter(h.db,clock,{verify:async()=>claims});
    const actor=await adapter.authenticate({authorization:'Bearer provider-signed-fixture'});
    await drain(h,publisher);await configurePolicyDurability(h.db,{required:true});
    const transaction=await createTransaction(h.db,clock,actor.userId,{itemTitle:'Strict creation'});
    const proof=await createOrGetProof(h.db,clock,actor.userId,transaction.transactionId);
    await expect(requireParticipant(h.db,proof.proofId,actor.userId)).rejects.toMatchObject({code:'POLICY_DURABILITY_PENDING'});
    await drain(h,publisher);
    const sequence=await h.db.query('SELECT MAX(sequence) AS head FROM policy_recovery_events');
    const contact=await h.db.query('SELECT * FROM user_verified_contacts');
    now=new Date(now.getTime()+1000);await adapter.authenticate({authorization:'Bearer same-claims'});
    expect((await h.db.query('SELECT MAX(sequence) AS head FROM policy_recovery_events')).rows).toEqual(sequence.rows);
    expect((await h.db.query('SELECT * FROM user_verified_contacts')).rows).toEqual(contact.rows);
    await expect(requireParticipant(h.db,proof.proofId,actor.userId)).resolves.toMatchObject({user_id:actor.userId});
    claims={...claims,email_verified:false};await adapter.authenticate({authorization:'Bearer changed-claims'});
    await expect(requireParticipant(h.db,proof.proofId,actor.userId)).rejects.toMatchObject({code:'POLICY_DURABILITY_PENDING'});
    await drain(h,publisher);await expect(requireParticipant(h.db,proof.proofId,actor.userId)).resolves.toBeTruthy();
    expect((await h.db.query('SELECT * FROM user_verified_contacts')).rows).toEqual([]);
  });
  it('journals direct revocation writes and ignores view counters, with strict reads blocked until signed policy publication',async()=>{
    const {h,seller,proofId}=await setup(),store=new Store(),publisher=publisherFor(store);
    const link=await createAccessLink(h.db,clock,seller,proofId,{scope:'SUMMARY',publicWebBaseUrl:'https://example.test'});
    const count=async()=>Number((await h.db.query<{count:string}>('SELECT COUNT(*) AS count FROM policy_recovery_events')).rows[0].count);
    const before=await count();await resolveAccessToken(h.db,clock,link.token);expect(await count()).toBe(before);
    await configurePolicyDurability(h.db,{required:true});
    await expect(resolveDisclosureContext(h.db,clock,{token:link.token})).rejects.toMatchObject({code:'POLICY_DURABILITY_PENDING'});
    await drain(h,publisher);await expect(resolveDisclosureContext(h.db,clock,{token:link.token})).resolves.toMatchObject({proofId});
    await h.db.query('UPDATE proof_access_links SET revoked_at=$2 WHERE id=$1',[link.accessLinkId,clock.now().toISOString()]);
    const event=(await h.db.query<{after_json:{revoked_at:string};before_json:{revoked_at:null}}>("SELECT * FROM policy_recovery_events WHERE table_name='proof_access_links' ORDER BY sequence DESC LIMIT 1")).rows[0];
    expect(event.before_json.revoked_at).toBeNull();expect(event.after_json.revoked_at).toBeTruthy();
    await drain(h,publisher);await expect(resolveAccessToken(h.db,clock,link.token)).rejects.toMatchObject({code:'ACCESS_LINK_REVOKED'});
    await expect(h.db.query('UPDATE proof_access_links SET revoked_at=NULL WHERE id=$1',[link.accessLinkId])).rejects.toThrow('ACCESS_REVOCATION_IMMUTABLE');
    await expect(h.db.query("DELETE FROM policy_recovery_events")).rejects.toThrow('AUDIT_IMMUTABLE');
  });
  it('makes a signed access-policy watermark a prerequisite for a core preservation receipt',async()=>{
    const {h,seller,proofId}=await setup(),store=new Store(),publisher=publisherFor(store);
    await h.db.transaction(tx=>enqueueRecoveryEvent(tx,clock,{operationId:'policy-dependent-evidence',kind:'EVIDENCE_COMMITTED',proofId,actorUserId:seller,payload:{fixture:true}}));
    await processRecoveryOutbox(h.db,clock,publisher);
    expect((await getRecoveryStatus(h.db,'policy-dependent-evidence')).errorCode).toBe('POLICY_DURABILITY_PENDING');
    expect((await h.db.query<{attempts:number}>('SELECT attempts FROM recovery_delivery')).rows[0].attempts).toBe(0);
    await drain(h,publisher);now=new Date(now.getTime()+3000);
    await processRecoveryOutbox(h.db,clock,publisher);
    expect((await getRecoveryStatus(h.db,'policy-dependent-evidence')).status).toBe('PRESERVED');
  });
  it.each([undefined, '', 'null'])('does not accept a policy receipt without a retained version (%s)',async(versionId)=>{
    const {h}=await setup(),store=new Store(),publisher=publisherFor(store);
    await configurePolicyDurability(h.db,{required:true});
    const incomplete:RecoveryPublisher={...publisher,store:{putIfAbsent:store.putIfAbsent.bind(store),get:store.get.bind(store),head:async()=>({versionId})}};
    expect((await processPolicyRecoveryOutbox(h.db,clock,incomplete)).state).toBe('PENDING');
    const first=(await h.db.query('SELECT state,receipt_json,error_code FROM policy_recovery_delivery ORDER BY sequence LIMIT 1')).rows[0];
    expect(first).toEqual({state:'PENDING',receipt_json:null,error_code:'RECOVERY_OBJECT_VERSION_REQUIRED'});
    await expect(assertPolicyAccessSafe(h.db)).rejects.toMatchObject({code:'POLICY_DURABILITY_PENDING'});
    now=new Date(now.getTime()+3000);await drain(h,publisher);
    await expect(assertPolicyAccessSafe(h.db)).resolves.toBeUndefined();
  });
  it('preserves policy envelope bytes on a lost response and fences access after a replay gap or untrusted watermark',async()=>{
    const {h}=await setup(),store=new Store(),publisher=publisherFor(store);store.loseOnce=true;
    expect((await processPolicyRecoveryOutbox(h.db,clock,publisher)).state).toBe('PENDING');const first=[...store.objects.values()][0];
    now=new Date(now.getTime()+3000);await drain(h,publisher);expect([...store.objects.values()][0]).toEqual(first);
    const envelopes=[...store.objects.values()],watermark=envelopes.at(-1)!;
    await expect(installPolicyRecoveryReplay(h.db,{envelopes:envelopes.slice(1),expectedWatermark:watermark,backupBoundaryHead:null,trustedPublicKey:publisher.trustedPublicKey})).rejects.toMatchObject({code:'POLICY_REPLAY_CHAIN_GAP'});
    await expect(assertPolicyAccessSafe(h.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
    await expect(installPolicyRecoveryReplay(h.db,{envelopes,expectedWatermark:watermark,backupBoundaryHead:null,trustedPublicKey:async()=>null})).rejects.toMatchObject({code:'POLICY_ENVELOPE_CONFLICT'});
    await expect(assertPolicyAccessSafe(h.db)).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
  });
  it('replays a post-backup revoked link into a closed restored database and refuses access until exact policy reconciliation',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'packproof-policy-restore-'));cleanup(()=>rm(dir,{recursive:true,force:true}));
    const source=await createPgliteDatabase(path.join(dir,'source')),closeSource=cleanup(source.close);
    const {h,seller,proofId,close}=await setup(source),store=new Store(),publisher=publisherFor(store);
    const link=await createAccessLink(h.db,clock,seller,proofId,{scope:'SUMMARY',publicWebBaseUrl:'https://example.test'});await drain(h,publisher);
    await close();await closeSource();await cp(path.join(dir,'source'),path.join(dir,'backup'),{recursive:true});
    const live=await createPgliteDatabase(path.join(dir,'source'));cleanup(live.close);const liveHarness=await createHarness(clock,{opened:live});cleanup(liveHarness.close);
    await revokeAccessLink(live.db,clock,seller,proofId,link.accessLinkId);await drain(liveHarness,publisher);
    const envelopes=[...store.objects.values()],expectedWatermark=envelopes.at(-1)!;
    const restored=await createPgliteDatabase(path.join(dir,'backup'));cleanup(restored.close);
    const oldLink=(await restored.db.query<{revoked_at:null}>('SELECT revoked_at FROM proof_access_links WHERE id=$1',[link.accessLinkId])).rows[0];expect(oldLink.revoked_at).toBeNull();
    await installPolicyRecoveryReplay(restored.db,{envelopes,expectedWatermark,backupBoundaryHead:null,trustedPublicKey:publisher.trustedPublicKey});
    expect((await inspectPolicyRecoveryReconciliation(restored.db)).mismatches.some(row=>row.table==='proof_access_links')).toBe(true);
    await expect(resolveDisclosureContext(restored.db,clock,{token:link.token})).rejects.toMatchObject({code:'POLICY_RECOVERY_UNAVAILABLE'});
    await expect(completePolicyRecoveryReconciliation(restored.db)).rejects.toMatchObject({code:'POLICY_RECONCILIATION_REQUIRED'});
    // Explicit isolated restore operation using the authenticated journal's exact revocation timestamp.
    const expected=JSON.parse(JSON.parse(expectedWatermark.toString()).eventCanonicalJson).change.after;
    await restored.db.query('UPDATE proof_access_links SET revoked_at=$2 WHERE id=$1',[link.accessLinkId,expected.revoked_at]);
    await completePolicyRecoveryReconciliation(restored.db);
    const restoredHarness={...liveHarness,db:restored.db};await drain(restoredHarness,publisher);
    await expect(resolveAccessToken(restored.db,clock,link.token)).rejects.toMatchObject({code:'ACCESS_LINK_REVOKED'});
  });
});
