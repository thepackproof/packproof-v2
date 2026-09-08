import {afterEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {auth,commitProofEvidence,createHarness,login,type TestHarness} from './helpers.js';
import {createDisclosureGrant,previewDisclosure,readDisclosedMedia,resolveDisclosureContext} from '../src/domain/disclosure.js';
import {createAccessLink,revokeAccessLink} from '../src/domain/access-links.js';
import {getPublicProof} from '../src/domain/public-proof.js';
import {approveRedaction,readRedactionForReview,renderRedaction} from '../src/domain/media-redaction.js';
import {createProofEmailSubscription,dispatchPendingProofEmails,reconcileProofNotifications} from '../src/domain/proof-notifications.js';
import {queueThumbnail,processPendingThumbnails,readThumbnail} from '../src/domain/media-thumbnails.js';
import {CognitoJwtAdapter,type CognitoTokenClaims} from '../src/auth/cognito-adapter.js';
import {createSignatureAnchor} from '../src/domain/signature.js';
import {setReceiptPreference} from '../src/domain/buyer-receipt.js';
import type {EmailMessage} from '../src/integrations/email/delivery.js';
let h:TestHarness;
afterEach(async()=>{await h?.close();});
async function proof() {
  const seller=await login(h.app,`seller-${Math.random()}`);
  const transaction=await request(h.app).post('/transactions').set(auth(seller)).send({externalReference:'PRIVATE-ORDER-123',itemTitle:'Collectible',shipping:{carrier:'UPS',trackingNumber:'PRIVATE-TRACKING'}});
  const p=await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
  return {seller,proofId:p.body.proofId as string};
}
async function verifiedBuyer(proofId:string,email:string) {
  const buyer=await login(h.app,`buyer-${Math.random()}`);
  await h.db.query('INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) SELECT $1,$2,user_id,$3 FROM proof_participants WHERE proof_id=$1 AND role=\'SELLER\'',[proofId,buyer,h.clock.now().toISOString()]);
  await h.db.query('INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,\'COGNITO\')',[buyer,email,h.clock.now().toISOString()]);
  await setReceiptPreference(h.db,h.clock,buyer,proofId,true);
  return buyer;
}
const secret='safe-receipt-test-secret-at-least-32-bytes';
describe('server disclosure and buyer receipt boundaries',()=>{
  it('keeps an independently authorized recipient grant when its historical creator cannot sign in',async()=>{
    h=await createHarness();const {seller,proofId}=await proof();
    const media=await commitProofEvidence(h,seller,proofId,{bytes:Buffer.from('retained recipient source'),contentType:'image/jpeg'});
    const input={purpose:'CLAIMS_REVIEW',fields:['status','evidence'],media:[{evidenceId:media.evidenceId,representation:'ORIGINAL'}],originalsReviewed:true,publicWebBaseUrl:'https://example.test'};
    const preview=await previewDisclosure(h.db,seller,proofId,input);
    const link=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...input,previewHash:preview.disclosure.viewHash});
    const token=('token' in link?link.token:'') as string;
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[seller]);
    expect((await readDisclosedMedia(h.db,h.clock,h.objectStore,token,media.evidenceId)).body.toString()).toBe('retained recipient source');
    const range=await request(h.app).get(`/public/proofs/${token}/evidence/${media.evidenceId}`).set('Range','bytes=0-3');
    expect(range.status).toBe(206);expect(range.headers['content-range']).toBe('bytes 0-3/25');
  });
  it('withholds original bytes and private fields from historical broad links',async()=>{
    h=await createHarness(); const {seller,proofId}=await proof();
    const media=await commitProofEvidence(h,seller,proofId,{bytes:Buffer.from('original secret'),contentType:'image/jpeg'});
    const link=await createAccessLink(h.db,h.clock,seller,proofId,{scope:'EVIDENCE_VIEW',publicWebBaseUrl:'https://example.test'});
    const view=await getPublicProof(h.db,h.clock,link.token);
    expect(JSON.stringify(view)).not.toContain('PRIVATE-');expect(view.evidence).toEqual([]);
    await expect(readDisclosedMedia(h.db,h.clock,h.objectStore,link.token,media.evidenceId)).rejects.toMatchObject({code:'INSUFFICIENT_SCOPE'});
    const other=await login(h.app,'outsider');
    await expect(resolveDisclosureContext(h.db,h.clock,{actorUserId:other,proofId})).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
  });
  it('requires exact preview and reviewed explicit scope, revokes future ranges and scope changes',async()=>{
    h=await createHarness();const {seller,proofId}=await proof();
    const media=await commitProofEvidence(h,seller,proofId,{bytes:Buffer.from('authorized original'),contentType:'image/jpeg'});
    const input={purpose:'CLAIMS_REVIEW',fields:['status','evidence'],media:[{evidenceId:media.evidenceId,representation:'ORIGINAL'}],originalsReviewed:true,publicWebBaseUrl:'https://example.test'};
    const preview=await previewDisclosure(h.db,seller,proofId,input);
    await expect(createDisclosureGrant(h.db,h.clock,seller,proofId,{...input,previewHash:'wrong'})).rejects.toMatchObject({code:'DISCLOSURE_PREVIEW_CHANGED'});
    const link=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...input,previewHash:preview.disclosure.viewHash});
    const token=('token' in link?link.token:'') as string;
    const live=await getPublicProof(h.db,h.clock,token);expect(live.disclosure.viewHash).toBe(preview.disclosure.viewHash);
    expect((await readDisclosedMedia(h.db,h.clock,h.objectStore,token,media.evidenceId)).body.toString()).toBe('authorized original');
    const activeRange=await request(h.app).get(`/public/proofs/${token}/evidence/${media.evidenceId}`).set('Range','bytes=0-3');
    expect(activeRange.status).toBe(206);expect(activeRange.headers['content-range']).toBe('bytes 0-3/19');
    const narrow={purpose:'BUYER_RECEIPT',fields:['status'],media:[],publicWebBaseUrl:'https://example.test'};
    const revised=await previewDisclosure(h.db,seller,proofId,narrow);
    await createDisclosureGrant(h.db,h.clock,seller,proofId,{...narrow,previewHash:revised.disclosure.viewHash,accessLinkId:link.accessLinkId});
    const range=await request(h.app).get(`/public/proofs/${token}/evidence/${media.evidenceId}`).set('Range','bytes=0-3');
    expect(range.status).toBe(403);
    await revokeAccessLink(h.db,h.clock,seller,proofId,link.accessLinkId);
    await expect(getPublicProof(h.db,h.clock,token)).rejects.toMatchObject({code:'ACCESS_LINK_REVOKED'});
  });
  it('renders opaque server pixels, requires hash review, and never falls back after render failure',async()=>{
    h=await createHarness();const {seller,proofId}=await proof();
    const dir=mkdtempSync(path.join(os.tmpdir(),'packproof-test-image-'));
    let image:Buffer;
    try {execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=red:s=32x32','-frames:v','1',path.join(dir,'source.png')]);image=readFileSync(path.join(dir,'source.png'));}finally{rmSync(dir,{recursive:true,force:true});}
    const source=await commitProofEvidence(h,seller,proofId,{contentType:'image/png',bytes:image});
    const derivative=await renderRedaction(h.db,h.clock,h.objectStore,seller,proofId,source.evidenceId,{masks:[{x:0,y:0,width:1,height:1}]});
    expect(derivative.status).toBe('READY');
    const raw=await readRedactionForReview(h.db,h.objectStore,seller,proofId,derivative.derivativeId);
    expect(raw.body.equals(image)).toBe(false);
    const scope={purpose:'BUYER_RECEIPT',fields:['status','evidence'],media:[{evidenceId:source.evidenceId,representation:'DERIVATIVE',derivativeId:derivative.derivativeId}],publicWebBaseUrl:'https://example.test'};
    await expect(previewDisclosure(h.db,seller,proofId,scope)).rejects.toMatchObject({code:'INVALID_DISCLOSURE'});
    await approveRedaction(h.db,h.clock,h.objectStore,seller,proofId,derivative.derivativeId,raw.sha256);
    const preview=await previewDisclosure(h.db,seller,proofId,scope);
    const link=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...scope,previewHash:preview.disclosure.viewHash});
    expect((await readDisclosedMedia(h.db,h.clock,h.objectStore,('token' in link?link.token:'') as string,source.evidenceId)).body.equals(raw.body)).toBe(true);
    const bad=await commitProofEvidence(h,seller,proofId,{contentType:'image/jpeg',bytes:Buffer.from('invalid image'),idempotencyKey:'bad-image'});
    const failed=await renderRedaction(h.db,h.clock,h.objectStore,seller,proofId,bad.evidenceId,{masks:[{x:0,y:0,width:1,height:1}]});
    expect(failed.status).toBe('FAILED');
    await expect(approveRedaction(h.db,h.clock,h.objectStore,seller,proofId,failed.derivativeId,'bad')).rejects.toMatchObject({code:'DERIVATIVE_UNAVAILABLE'});
    expect((await h.db.query<{sha256:string}>('SELECT sha256 FROM evidence WHERE id=$1',[source.evidenceId])).rows[0].sha256).toBe(derivative.sourceSha256);
  },30000);
  it('requires verified buyer consent and deduplicates concurrent email workers without sensitive previews',async()=>{
    h=await createHarness(); const {seller,proofId}=await proof();const email='buyer@example.test';
    const input={email,publicWebBaseUrl:'https://example.test',trackerLinkSecret:secret};
    await expect(createProofEmailSubscription(h.db,h.clock,seller,proofId,input)).rejects.toMatchObject({code:'RECEIPT_CONTACT_UNVERIFIED'});
    const buyer=await verifiedBuyer(proofId,email);
    await createProofEmailSubscription(h.db,h.clock,seller,proofId,input);
    const messages:EmailMessage[]=[];const delivery={enabled:true,send:async(m:EmailMessage)=>{messages.push(m);}};
    await Promise.all([dispatchPendingProofEmails(h.db,h.clock,delivery,'https://example.test',secret),dispatchPendingProofEmails(h.db,h.clock,delivery,'https://example.test',secret)]);
    expect(messages).toHaveLength(1);expect(JSON.stringify(messages)).not.toContain('PRIVATE-');expect(JSON.stringify(messages)).not.toContain('Collectible');
    await setReceiptPreference(h.db,h.clock,buyer,proofId,false);
    await reconcileProofNotifications(h.db,h.clock,proofId);
    await dispatchPendingProofEmails(h.db,h.clock,delivery,'https://example.test',secret);expect(messages).toHaveLength(1);
  });
});

describe('committed replay thumbnail jobs',()=>{
  it('deduplicates exact anchor transforms and serves verified thumbnail bytes only to participants',async()=>{
    h=await createHarness();const {seller,proofId}=await proof();
    const bytes=readFileSync(new URL('./fixtures/camera-recording.mp4',import.meta.url));
    const evidence=await commitProofEvidence(h,seller,proofId,{contentType:'video/mp4',bytes});
    const anchor=await createSignatureAnchor(h.db,h.clock,seller,proofId,{evidenceId:evidence.evidenceId,startMs:0,endMs:100,label:'Item',idempotencyKey:'thumb-anchor'});
    const job=await queueThumbnail(h.db,h.clock,seller,proofId,anchor.anchorId);
    const duplicate=await queueThumbnail(h.db,h.clock,seller,proofId,anchor.anchorId);
    expect(duplicate.derivativeId).toBe(job.derivativeId);expect(job.status).toBe('PENDING');
    expect(await processPendingThumbnails(h.db,h.clock,h.objectStore)).toEqual({processed:1,failed:0});
    const media=await readThumbnail(h.db,h.objectStore,seller,proofId,job.derivativeId);expect(media.body.subarray(1,4).toString()).toBe('PNG');
    const stranger=await login(h.app,'thumbnail-stranger');
    await expect(readThumbnail(h.db,h.objectStore,stranger,proofId,job.derivativeId)).rejects.toMatchObject({code:'PARTICIPANT_NOT_AUTHORIZED'});
    await expect(approveRedaction(h.db,h.clock,h.objectStore,seller,proofId,job.derivativeId,'unredacted')).rejects.toMatchObject({code:'DERIVATIVE_UNAVAILABLE'});
    expect(await processPendingThumbnails(h.db,h.clock,h.objectStore)).toEqual({processed:0,failed:0});
  },30000);
});

describe('provider-verified receipt contact mapping',()=>{
  it('takes verified email only from an ID-token claim and removes a previous contact after unverification',async()=>{
    h=await createHarness();
    let claims:CognitoTokenClaims={sub:'receipt-contact-subject',token_use:'access',iss:'test-verifier',exp:Math.floor(h.clock.now().getTime()/1000)+3600,email:'verified@example.test',email_verified:true};
    const adapter=new CognitoJwtAdapter(h.db,h.clock,{verify:async()=>claims});
    const first=await adapter.authenticate({authorization:'Bearer verified-by-test-adapter'});
    expect((await h.db.query('SELECT 1 FROM user_verified_contacts WHERE user_id=$1',[first.userId])).rows).toHaveLength(0);
    claims={...claims,token_use:'id'};await adapter.authenticate({authorization:'Bearer verified-by-test-adapter'});
    expect((await h.db.query('SELECT email_normalized FROM user_verified_contacts WHERE user_id=$1',[first.userId])).rows).toEqual([{email_normalized:'verified@example.test'}]);
    claims={...claims,email:'replacement@example.test',email_verified:false};await adapter.authenticate({authorization:'Bearer verified-by-test-adapter'});
    expect((await h.db.query('SELECT 1 FROM user_verified_contacts WHERE user_id=$1',[first.userId])).rows).toHaveLength(0);
  });
});

describe('emailed recipient scope follows its reviewed grant',()=>{
  it('narrows and revokes emailed copies, and updates an existing recipient to the newly selected preview',async()=>{
    h=await createHarness();const {seller,proofId}=await proof();const email='scoped-receipt@example.test';
    await verifiedBuyer(proofId,email);
    const wide={purpose:'BUYER_RECEIPT',fields:['status','order'],media:[],publicWebBaseUrl:'https://example.test'};
    const p=await previewDisclosure(h.db,seller,proofId,wide);
    const source=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...wide,previewHash:p.disclosure.viewHash});
    const subInput={email,publicWebBaseUrl:'https://example.test',trackerLinkSecret:secret,recipientGrantId:source.accessLinkId};
    const subscription=await createProofEmailSubscription(h.db,h.clock,seller,proofId,subInput);
    const token=new URL(subscription.viewUrl).pathname.split('/').pop()!;
    expect((await getPublicProof(h.db,h.clock,token)).tracker.itemTitle).toBe('Collectible');
    const narrow={...wide,fields:['status']};const np=await previewDisclosure(h.db,seller,proofId,narrow);
    await createDisclosureGrant(h.db,h.clock,seller,proofId,{...narrow,accessLinkId:source.accessLinkId,previewHash:np.disclosure.viewHash});
    expect((await getPublicProof(h.db,h.clock,token)).tracker.itemTitle).toBeNull();
    const replacement=await createDisclosureGrant(h.db,h.clock,seller,proofId,{...wide,previewHash:p.disclosure.viewHash});
    const updated=await createProofEmailSubscription(h.db,h.clock,seller,proofId,{...subInput,recipientGrantId:replacement.accessLinkId});
    expect(updated.subscriptionId).toBe(subscription.subscriptionId);
    expect((await getPublicProof(h.db,h.clock,token)).tracker.itemTitle).toBe('Collectible');
    await createProofEmailSubscription(h.db,h.clock,seller,proofId,{...subInput,recipientGrantId:replacement.accessLinkId});
    expect((await h.db.query('SELECT 1 FROM proof_notification_outbox WHERE subscription_id=$1',[subscription.subscriptionId])).rows).toHaveLength(2);
    await revokeAccessLink(h.db,h.clock,seller,proofId,replacement.accessLinkId);
    await expect(getPublicProof(h.db,h.clock,token)).rejects.toMatchObject({code:'ACCESS_LINK_REVOKED'});
  });
});
