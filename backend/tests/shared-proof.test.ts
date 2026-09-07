import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auth, commitFulfillmentAndAttest, commitProofEvidence, createHarness, login, type TestHarness } from './helpers.js';
import { createDisclosureGrant, previewDisclosure, readDisclosedMedia } from '../src/domain/disclosure.js';
import { createAccessLink, revokeAccessLink } from '../src/domain/access-links.js';
import { getPublicProof } from '../src/domain/public-proof.js';
import { initializeEvidenceUpload } from '../src/domain/evidence.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { acceptCommerceReceiver, commitStageEvidence, createCommerceStage, initializeStageEvidence, inviteCommerceReceiver } from '../src/domain/commerce-lifecycle.js';
import { createProofEmailSubscription } from '../src/domain/proof-notifications.js';
import { setReceiptPreference } from '../src/domain/buyer-receipt.js';
import type { ObjectStore } from '../src/s3/object-store.js';

let h: TestHarness;
afterEach(async () => { await h?.close(); });
const input = { purpose: 'SHARED_PROOF', publicWebBaseUrl: 'https://example.test' };

async function createProof() {
  const seller = await login(h.app, `shared-seller-${Math.random()}`);
  const transaction = await request(h.app).post('/transactions').set(auth(seller)).send({
    externalReference: 'PRIVATE-ORDER-123', itemTitle: 'Vintage camera',
    shipping: { carrier: 'UPS', trackingNumber: 'PRIVATE-TRACKING' },
  });
  const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
  expect(proof.status).toBe(200);
  return { seller, proofId: proof.body.proofId as string };
}
async function share(seller: string, proofId: string, expiresAt?: string) {
  const preview = await previewDisclosure(h.db, seller, proofId, input);
  const result = await createDisclosureGrant(h.db, h.clock, seller, proofId, {
    ...input, originalsReviewed: true, previewHash: preview.disclosure.viewHash, expiresAt,
  });
  if (!('token' in result)) throw new Error('Expected a new link');
  return result;
}

describe('one live shared Proof', () => {
  it('uses server-owned content, requires reviewed preview, and includes later recordings identically in every new link', async () => {
    h = await createHarness();
    const { seller, proofId } = await createProof();
    const first = await commitProofEvidence(h, seller, proofId, { contentType: 'image/jpeg', bytes: Buffer.from('first original') });
    const preview = await previewDisclosure(h.db, seller, proofId, input);
    expect(preview.disclosure).toMatchObject({ purpose: 'SHARED_PROOF', liveProof: true, fields: ['status', 'order', 'shipping', 'evidence', 'statements'] });
    expect(preview.evidence.map(e => e.evidenceId)).toEqual([first.evidenceId]);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
    await expect(previewDisclosure(h.db, seller, proofId, { ...input, fields: ['status'], media: [] })).rejects.toMatchObject({ code: 'INVALID_DISCLOSURE' });
    await expect(createDisclosureGrant(h.db, h.clock, seller, proofId, { ...input, previewHash: preview.disclosure.viewHash })).rejects.toMatchObject({ code: 'INVALID_DISCLOSURE' });
    await expect(createDisclosureGrant(h.db, h.clock, seller, proofId, { ...input, originalsReviewed: true, previewHash: 'stale' })).rejects.toMatchObject({ code: 'DISCLOSURE_PREVIEW_CHANGED' });
    const outsider = await login(h.app, 'shared-outsider');
    await expect(previewDisclosure(h.db, outsider, proofId, input)).rejects.toMatchObject({ code: 'PARTICIPANT_NOT_AUTHORIZED' });
    const a = await share(seller, proofId);
    const b = await share(seller, proofId);
    const before = await getPublicProof(h.db, h.clock, a.token);
    expect(before.disclosure.viewHash).toBe((await getPublicProof(h.db, h.clock, b.token)).disclosure.viewHash);
    expect((await readDisclosedMedia(h.db, h.clock, h.objectStore, a.token, first.evidenceId)).body.toString()).toBe('first original');

    const pending = await initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proofId, { contentType: 'image/jpeg', idempotencyKey: 'not-committed' });
    await h.objectStore.put(pending.objectKey, Buffer.from('unfinished private upload'), 'image/jpeg');
    await expect(readDisclosedMedia(h.db, h.clock, h.objectStore, a.token, pending.evidenceId)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    const added = await commitProofEvidence(h, seller, proofId, { contentType: 'image/jpeg', bytes: Buffer.from('later original'), idempotencyKey: 'later' });
    const updatedA = await getPublicProof(h.db, h.clock, a.token);
    const updatedB = await getPublicProof(h.db, h.clock, b.token);
    expect(updatedA.evidence.map(e => e.evidenceId)).toEqual([first.evidenceId, added.evidenceId]);
    expect(updatedB.evidence).toEqual(updatedA.evidence);
    expect(updatedA.disclosure.viewHash).toBe(updatedB.disclosure.viewHash);
    expect(updatedA.disclosure.viewHash).not.toBe(before.disclosure.viewHash);
    await expect(createDisclosureGrant(h.db, h.clock, seller, proofId, { ...input, originalsReviewed: true, previewHash: preview.disclosure.viewHash })).rejects.toMatchObject({ code: 'DISCLOSURE_PREVIEW_CHANGED' });
    expect((await readDisclosedMedia(h.db, h.clock, h.objectStore, b.token, added.evidenceId)).body.toString()).toBe('later original');

    const legacy = await createAccessLink(h.db, h.clock, seller, proofId, { scope: 'EVIDENCE_VIEW', publicWebBaseUrl: input.publicWebBaseUrl });
    expect((await getPublicProof(h.db, h.clock, legacy.token)).evidence).toEqual([]);
    await expect(readDisclosedMedia(h.db, h.clock, h.objectStore, legacy.token, added.evidenceId)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  it('enforces expiry, revocation during a media read, and committed-byte integrity', async () => {
    let now = new Date('2026-09-06T12:00:00Z');
    h = await createHarness({ now: () => now });
    const { seller, proofId } = await createProof();
    const source = await commitProofEvidence(h, seller, proofId, { contentType: 'image/jpeg', bytes: Buffer.from('original bytes') });
    const expiring = await share(seller, proofId, '2026-09-07T12:00:00Z');
    const revoked = await share(seller, proofId);
    const corruptStore: ObjectStore = Object.assign(Object.create(h.objectStore), {
      get: async () => ({ body: Buffer.from('changed bytes'), contentType: 'image/jpeg' }),
    });
    await expect(readDisclosedMedia(h.db, h.clock, corruptStore, expiring.token, source.evidenceId)).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_FAILURE' });
    const revokingStore: ObjectStore = Object.assign(Object.create(h.objectStore), {
      get: async (key: string) => {
        const original = await h.objectStore.get(key);
        await revokeAccessLink(h.db, h.clock, seller, proofId, revoked.accessLinkId);
        return original;
      },
    });
    await expect(readDisclosedMedia(h.db, h.clock, revokingStore, revoked.token, source.evidenceId)).rejects.toMatchObject({ code: 'ACCESS_LINK_REVOKED' });
    now = new Date('2026-09-07T12:00:00Z');
    await expect(getPublicProof(h.db, h.clock, expiring.token)).rejects.toMatchObject({ code: 'ACCESS_LINK_EXPIRED' });
    await request(h.app).get(`/public/proofs/${expiring.token}/evidence/${source.evidenceId}`).set('Range', 'bytes=0-3').expect(404);
  });

  it('includes committed receipt sources in the same live Proof and preserves the finalized manifest', async () => {
    h = await createHarness();
    const { seller, proofId } = await createProof();
    await commitFulfillmentAndAttest(h, seller, proofId);
    const finalized = await finalizeProof(h.db, h.clock, seller, proofId);
    const link = await share(seller, proofId);
    const buyer = await login(h.app, 'shared-receiver');
    await inviteCommerceReceiver(h.db, h.clock, seller, proofId, buyer);
    await acceptCommerceReceiver(h.db, h.clock, buyer, proofId);
    const stage = await createCommerceStage(h.db, h.clock, buyer, proofId, 'RECEIPT');
    const upload = await initializeStageEvidence(h.db, h.clock, h.objectStore, buyer, proofId, stage.stageId, { contentType: 'image/jpeg', idempotencyKey: 'receipt-original' });
    const bytes = Buffer.concat([Buffer.from([255,216,255]),Buffer.from('original receipt photo')]);
    await request(h.app).put(new URL(upload.upload.url).pathname).set('Content-Type','image/jpeg').send(bytes).expect(200);
    await expect(readDisclosedMedia(h.db, h.clock, h.objectStore, link.token, upload.evidenceId)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    await commitStageEvidence(h.db, h.clock, h.objectStore, buyer, proofId, stage.stageId, upload.evidenceId, undefined);
    const current = await getPublicProof(h.db, h.clock, link.token);
    expect(current.evidence.find(e => e.evidenceId === upload.evidenceId)).toMatchObject({ slot: 'Receipt', stageId: stage.stageId, representation: 'ORIGINAL' });
    expect((await readDisclosedMedia(h.db, h.clock, h.objectStore, link.token, upload.evidenceId)).body.equals(bytes)).toBe(true);
    const corruptStore: ObjectStore = Object.assign(Object.create(h.objectStore), {
      get: async () => ({ body: Buffer.from('altered receipt photo'), contentType: 'image/jpeg' }),
    });
    await expect(readDisclosedMedia(h.db, h.clock, corruptStore, link.token, upload.evidenceId)).rejects.toMatchObject({ code: 'EVIDENCE_INTEGRITY_FAILURE' });
    const another = await share(seller, proofId);
    expect((await getPublicProof(h.db, h.clock, another.token)).evidence).toEqual(current.evidence);
    expect((await finalizeProof(h.db, h.clock, seller, proofId)).manifest).toEqual(finalized.manifest);
  }, 30000);

  it('binds consented email links to the same live shared Proof and parent revocation', async () => {
    h = await createHarness();
    const { seller, proofId } = await createProof();
    const buyer = await login(h.app, 'shared-email-buyer');
    const email = 'shared-buyer@example.test';
    await h.db.query('INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) VALUES($1,$2,$3,$4)', [proofId, buyer, seller, h.clock.now().toISOString()]);
    await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')", [buyer, email, h.clock.now().toISOString()]);
    await setReceiptPreference(h.db, h.clock, buyer, proofId, true);
    const parent = await share(seller, proofId);
    const subscription = await createProofEmailSubscription(h.db, h.clock, seller, proofId, {
      email, publicWebBaseUrl: input.publicWebBaseUrl, trackerLinkSecret: 'shared-proof-email-test-secret-at-least-32-bytes', recipientGrantId: parent.accessLinkId,
    });
    const token = new URL(subscription.viewUrl).pathname.split('/').pop()!;
    const source = await commitProofEvidence(h, seller, proofId, { contentType: 'image/jpeg', bytes: Buffer.from('new packing detail') });
    const emailed = await getPublicProof(h.db, h.clock, token);
    expect(emailed.evidence.map(e => e.evidenceId)).toEqual([source.evidenceId]);
    expect(emailed.disclosure.viewHash).toBe((await getPublicProof(h.db, h.clock, parent.token)).disclosure.viewHash);
    await revokeAccessLink(h.db, h.clock, seller, proofId, parent.accessLinkId);
    await expect(getPublicProof(h.db, h.clock, token)).rejects.toMatchObject({ code: 'ACCESS_LINK_REVOKED' });
  });
});
