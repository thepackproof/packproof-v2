import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { auth, createHarness, createUser, type TestHarness } from './helpers.js';
import { bindIntent, issueIntent, sealCapture } from '../src/capture/service.js';
import { CORE_VERSION, chainSegment, createManifest, manifestDigest, type CapabilitySnapshot, type Observation } from '../src/capture/core.js';
import { captureCompletionDestination, issueCaptureCompletionReceipt, readCaptureCompletionReceipt, verifyCaptureCompletionReceipt,
  type CaptureCompletionContext, type CaptureCompletionReceipt, type CaptureReceiptTrustKey } from '../src/capture/completion-receipt.js';
import { completeCaptureSession } from '../src/domain/capture-sessions.js';
import { initializeEvidenceUpload, commitEvidence } from '../src/domain/evidence.js';
import { commitAttestation } from '../src/domain/attestations.js';
import { finalizeProof } from '../src/domain/finalize.js';
import type { ManifestSigner } from '../src/domain/manifest-signing.js';
import type { Database } from '../src/db/database.js';
import { sha256Hex } from '../src/hash.js';

const capabilities: CapabilitySnapshot = { surface: 'WEB', cameraSource: 'UNKNOWN', timing: 'MONOTONIC', barcode: false,
  itemVisibility: false, durableJournal: true, incrementalMedia: true, audio: false, deviceAuthentication: 'UNAVAILABLE',
  appIntegrity: 'UNAVAILABLE', storageReserveBytes: 100000000, coreVersion: CORE_VERSION };
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const clock = { now: () => new Date('2026-09-10T12:00:00.000Z') };
const trustedKey: CaptureReceiptTrustKey = { keyId: 'receipt-fixture-key', algorithm: 'ECDSA_SHA_256', status: 'ACTIVE',
  publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
let signCount = 0;
const signer: ManifestSigner = { signManifest: async input => {
  signCount++;
  return { algorithm: 'ECDSA_SHA_256', keyId: trustedKey.keyId, signedAt: clock.now().toISOString(),
    signatureBase64: sign('sha256', Buffer.from(input.canonicalJson), pair.privateKey).toString('base64') };
} };

describe('authenticated capture host completion', () => {
  let h: TestHarness, actor: string, other: string, captureId: string, proofId: string;
  let receipt: CaptureCompletionReceipt, expected: CaptureCompletionContext;

  beforeAll(async () => {
    h = await createHarness(clock);
    actor = await createUser(h); other = await createUser(h);
    const transaction = await request(h.app).post('/transactions').set(auth(actor)).send({ itemTitle: 'Host capture lens' });
    const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(actor)).send({});
    proofId = proof.body.proofId;
    const intent = await issueIntent(h.db, clock, actor, proofId, ['WEB']);
    const bound = await bindIntent(h.db, clock, actor, { launchToken: intent.launchToken, capabilities });
    captureId = bound.session.id;

    await expect(issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_PENDING' });
    const bytes = await readFile(new URL('./fixtures/camera-recording.mp4', import.meta.url));
    const hash = async (value: string) => sha256Hex(value);
    const source = { sha256: sha256Hex(bytes), byteSize: bytes.length, contentType: 'video/mp4', durationMs: 200 };
    const segment = await chainSegment({ sequence: 0, offsetBytes: 0, byteSize: bytes.length, sha256: source.sha256,
      previous: null, startMs: 0, endMs: 200, timing: 'WHOLE_RECORDING' }, hash);
    const observations: Observation[] = [
      { id: 'start', captureId, type: 'CAPTURE_STARTED', startMs: 0, endMs: 0, source: 'DEVICE', model: null, confidence: null, value: null, timePrecision: 'APPROXIMATE' },
      { id: 'end', captureId, type: 'CAPTURE_ENDED', startMs: 200, endMs: 200, source: 'DEVICE', model: null, confidence: null, value: null, timePrecision: 'APPROXIMATE' },
    ];
    const manifest = await createManifest(bound.context, source, [segment], observations, hash);
    const digest = await manifestDigest(manifest, hash);
    await completeCaptureSession(h.db, clock, actor, proofId, captureId, { ...source, recordedDurationMs: 200 });
    await sealCapture(h.db, clock, actor, captureId, { source, segments: [segment], observations, sha256: digest });
    await expect(issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_PENDING' });
    const upload = await initializeEvidenceUpload(h.db, clock, h.objectStore, actor, proofId,
      { contentType: 'video/mp4', evidenceType: 'FULFILLMENT_CAPTURE', captureSessionId: captureId, idempotencyKey: 'host-source' });
    await h.objectStore.put(upload.objectKey, bytes, 'video/mp4');
    await commitEvidence(h.db, clock, h.objectStore, actor, proofId, upload.evidenceId);
    await expect(issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_PENDING' });
    await commitAttestation(h.db, clock, actor, proofId, { statement: 'PACKED_DESCRIBED_ITEM', relatedEvidenceId: upload.evidenceId });
    const final = await finalizeProof(h.db, clock, actor, proofId, signer);
    await expect(issueCaptureCompletionReceipt(h.db, clock, actor, captureId)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_SIGNING_UNAVAILABLE' });
    await expect(readCaptureCompletionReceipt(h.db, actor, captureId)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_NOT_ISSUED' });
    expected = { intentId: intent.intentId, captureId, proofId, actorId: actor, transactionId: bound.context.transactionId,
      transactionDigest: bound.context.transactionDigest, contextSha256: bound.contextSha256, captureManifestSha256: digest,
      evidenceId: upload.evidenceId, sourceSha256: source.sha256, finalManifestId: final.manifest.manifestId,
      finalManifestSha256: final.manifest.sha256, ...captureCompletionDestination(intent.intentId, proofId) };
    receipt = await issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer);
  }, 30000);
  afterAll(async () => h?.close());

  it('signs only the real committed source and finalized root with the original launch context', () => {
    expect(receipt.payload).toMatchObject({ ...expected, schema: 'packproof.capture-completion/1', state: 'FINALIZED' });
    expect(verifyCaptureCompletionReceipt(receipt, expected, trustedKey)).toBe(true);
  });

  it('returns exactly the original receipt after repeated polling, clock changes and signer outage', async () => {
    const before = signCount;
    expect(await issueCaptureCompletionReceipt(h.db, { now: () => new Date('2026-10-01T00:00:00Z') }, actor, captureId)).toEqual(receipt);
    expect(await readCaptureCompletionReceipt(h.db, actor, captureId)).toEqual(receipt);
    const results = await Promise.all([
      issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer),
      issueCaptureCompletionReceipt(h.db, clock, actor, captureId, signer),
    ]);
    expect(results).toEqual([receipt, receipt]);
    expect(signCount).toBe(before);
    expect((await h.db.query('SELECT id FROM capture_completion_receipts')).rows).toHaveLength(1);
    expect((await h.db.query("SELECT id FROM audit_events WHERE event_type='CAPTURE_COMPLETION_RECEIPT_ISSUED'")).rows).toHaveLength(1);
  });

  it('denies receipt read and issuance to a different authenticated account', async () => {
    await expect(readCaptureCompletionReceipt(h.db, other, captureId)).rejects.toMatchObject({ code: 'CAPTURE_SESSION_NOT_FOUND' });
    await expect(issueCaptureCompletionReceipt(h.db, clock, other, captureId, signer)).rejects.toMatchObject({ code: 'CAPTURE_SESSION_NOT_FOUND' });
  });

  it('fails closed on corrupted stored bytes or a rehashed context-swapped stored receipt', async () => {
    const corrupt = (base: Database, rewrite: (row: Record<string, unknown>) => Record<string, unknown>): Database => ({
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await base.query<T>(sql, params);
        return sql.startsWith('SELECT * FROM capture_completion_receipts')
          ? { ...result, rows: result.rows.map(row => rewrite(row as Record<string, unknown>) as T) } : result;
      },
      transaction: async fn => base.transaction(tx => fn(corrupt(tx, rewrite))),
    });
    for (const rewrite of [
      (row: Record<string, unknown>) => ({ ...row, sha256: '0'.repeat(64) }),
      (row: Record<string, unknown>) => {
        const payload = JSON.parse(String(row.canonical_json)); payload.actorId = other;
        const canonicalJson = JSON.stringify(payload, Object.keys(payload).sort());
        return { ...row, canonical_json: canonicalJson, sha256: sha256Hex(canonicalJson) };
      },
    ]) {
      const db = corrupt(h.db, rewrite);
      await expect(readCaptureCompletionReceipt(db, actor, captureId)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_STORED_INVALID' });
      await expect(issueCaptureCompletionReceipt(db, clock, actor, captureId, signer)).rejects.toMatchObject({ code: 'CAPTURE_COMPLETION_STORED_INVALID' });
    }
  });

  it.each(['actorId','proofId','intentId','captureId','transactionId','transactionDigest','contextSha256',
    'captureManifestSha256','evidenceId','sourceSha256','finalManifestId','finalManifestSha256','audience','returnTarget'] as const)
  ('rejects a valid receipt replayed under a different expected %s', key => {
    expect(verifyCaptureCompletionReceipt(receipt, { ...expected, [key]: expected[key] + 'x' }, trustedKey)).toBe(false);
  });

  it('rejects changed bytes/digests, mismatched envelope payloads, bad signatures and receipt-selected keys', () => {
    expect(verifyCaptureCompletionReceipt({ ...receipt, sha256: '0'.repeat(64) }, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt({ ...receipt, canonicalJson: receipt.canonicalJson + ' ' }, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt({ ...receipt, payload: { ...receipt.payload, sourceSha256: '0'.repeat(64) } }, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt({ ...receipt, payload: { ...receipt.payload, extra: true } }, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt({ ...receipt, signature: { ...receipt.signature, signatureBase64: 'AAAA' } }, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt(receipt, expected, { ...trustedKey, keyId: 'untrusted-key' })).toBe(false);
    expect(verifyCaptureCompletionReceipt(receipt, expected, { ...trustedKey, status: 'REVOKED' })).toBe(false);
    expect(verifyCaptureCompletionReceipt(receipt, expected, { ...trustedKey, publicKeyPem: '' })).toBe(false);
    expect(verifyCaptureCompletionReceipt(null, expected, trustedKey)).toBe(false);
    expect(verifyCaptureCompletionReceipt(receipt, {} as CaptureCompletionContext, trustedKey)).toBe(false);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const unsupportedReceipt = { ...receipt, signature: { ...receipt.signature,
      signatureBase64: sign('sha256', Buffer.from(receipt.canonicalJson), p384.privateKey).toString('base64') } };
    expect(verifyCaptureCompletionReceipt(unsupportedReceipt, expected, { ...trustedKey,
      publicKeyPem: p384.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toBe(false);
  });

  it('cannot change or delete issued completion and rejects arbitrary return URLs', async () => {
    await expect(h.db.query('UPDATE capture_completion_receipts SET sha256=$1 WHERE capture_session_id=$2', ['0'.repeat(64), captureId]))
      .rejects.toThrow('CAPTURE_COMPLETION_RECEIPT_IMMUTABLE');
    await expect(h.db.query('DELETE FROM capture_completion_receipts WHERE capture_session_id=$1', [captureId]))
      .rejects.toThrow('CAPTURE_COMPLETION_RECEIPT_IMMUTABLE');
    expect(() => captureCompletionDestination('intent', '//attacker.example/callback')).toThrow();
    expect(() => captureCompletionDestination('intent?token=secret', proofId)).toThrow();
  });
});
