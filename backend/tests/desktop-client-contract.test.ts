import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createHarness, createUser, type TestHarness } from './helpers.js';
import { DesktopApi } from '../../desktop/src/main/api.js';
import { DesktopEvidenceTransport } from '../../desktop/src/main/evidence-api.js';
import type { CaptureMetadata } from '../../desktop/src/main/evidence/types.js';

let harness: TestHarness, server: Server, seller: string, api: DesktopApi, transport: DesktopEvidenceTransport, media: Buffer;
const signal = () => new AbortController().signal;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  harness = await createHarness({ now: () => new Date('2026-09-27T12:00:00Z') });
  seller = await createUser(harness);
  media = await readFile(new URL('./fixtures/camera-recording.mp4', import.meta.url));
  server = await new Promise<Server>(resolve => { const value = harness.app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to start');
  api = new DesktopApi({ config: { channel: 'development', apiBaseUrl: `http://127.0.0.1:${address.port}`, webBaseUrl: 'https://thepackproof.com', cognito: { region: 'us-east-1', clientId: '', userPoolId: '' } }, getAccountId: () => seller, getToken: async () => seller });
  transport = new DesktopEvidenceTransport(api);
}, 30_000);
afterAll(async () => { await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve())); await harness?.close(); });

function metadata(detections: CaptureMetadata['detections'] = []): CaptureMetadata {
  return { captureSource: 'DESKTOP_CAMERA', installationId: 'desktop-integration-install', appVersion: '1.0.0', platform: 'win32', startedAt: '2026-09-26T13:00:00.000Z', endedAt: '2026-09-26T13:00:01.000Z', camera: 'USB camera fixture', detections, provenance: 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED', offline: true };
}
describe('desktop native transport against real PackProof API', () => {
  it('registers honest offline capture, resumes original bytes, reconciles commit, attests, freezes and streams range/export', async () => {
    const proof = await api.createProof({ itemTitle: 'Desktop integration shipment', externalReference: 'desktop-integration-order' });
    expect(proof.status).toBe('READY_FOR_EVIDENCE');
    expect((await api.listProofs()).map(row => row.proofId)).toContain(proof.proofId);
    expect((await api.resolvePackingStation('desktop-integration-order')).proofId).toBe(proof.proofId);
    expect(await api.listOrders()).toEqual([]);
    const context = { accountId: seller, proofId: proof.proofId, jobId: 'desktop-full-flow' };
    const receipt = { sha256: sha256(media), byteSize: media.length };
    const recording = { ...context, ...receipt, mimeType: 'video/mp4', recordedDurationMs: 1000, metadata: metadata([
      { value: '1Z999AA10123456784', format: 'CODE_128', detectedAtMs: 100, confirmed: true },
      { value: '1Z999AA10123456785', format: 'CODE_128', detectedAtMs: 150, notThisPackage: true },
    ]) };
    expect((await transport.authorizeCapture(context, signal())).id).toBeUndefined();
    const capture = await transport.registerCapture(recording, signal());
    expect(capture.id).toMatch(/^cap_/);
    const replay = await transport.registerCapture(recording, signal());
    expect(replay.id).toBe(capture.id);
    const uploadInput = { ...context, ...receipt, mimeType: 'video/mp4', captureSessionId: capture.id! };
    const upload = await transport.initializeUpload(uploadInput, signal());
    expect((await transport.initializeUpload(uploadInput, signal())).evidenceId).toBe(upload.evidenceId);
    const identity = { ...context, evidenceId: upload.evidenceId };
    const initial = await transport.inspectUpload(identity, signal());
    expect(initial.status).toBe('PENDING'); expect(initial.parts).toEqual([]);
    expect(await transport.uploadPart({ ...identity, partNumber: 1, bytes: media, sha256: receipt.sha256 }, signal())).toEqual(receipt);
    const restart = await transport.inspectUpload(identity, signal());
    expect(restart.parts).toEqual([{ partNumber: 1, ...receipt }]);
    expect(await transport.completeUpload({ ...identity, ...receipt }, signal())).toEqual(receipt);
    expect(await transport.commitUpload({ ...identity, ...receipt }, signal())).toEqual(receipt);
    expect(await transport.inspectUpload(identity, signal())).toEqual({ status: 'COMMITTED', ...receipt });
    await transport.attestAndFinalize({ ...identity, captureSessionId: capture.id!, statement: 'PACKED_DESCRIBED_ITEM' }, signal());
    await transport.attestAndFinalize({ ...identity, captureSessionId: capture.id!, statement: 'PACKED_DESCRIBED_ITEM' }, signal());
    const final = await api.getProof(proof.proofId);
    expect(final.status).toBe('FINALIZED');
    expect(final.transaction.shipping?.trackingNumber).toBe('1Z999AA10123456784');
    expect(final.evidence[0]).toMatchObject({ sha256: receipt.sha256, byteSize: media.length, captureOrigin: 'CLIENT_REPORTED_DESKTOP_CAPTURE', captureRegistrationTiming: 'POST_CAPTURE_CLIENT_REPORTED' });
    // Recovered server commit must work even after immutable finalization.
    expect((await transport.registerCapture({ ...recording, captureSessionId: capture.id }, signal())).id).toBe(capture.id);
    const range = await api.getEvidence(proof.proofId, upload.evidenceId, signal(), 'bytes=0-31');
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe(`bytes 0-31/${media.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(media.subarray(0, 32));
    const shared = await api.createAccessLink(proof.proofId); expect(shared.url).toContain('/p/');
    const archive = await api.exportProofPackage(proof.proofId); expect(archive.headers.get('content-type')).toContain('application/zip');
    const bytes = Buffer.from(await archive.arrayBuffer()); expect(bytes.subarray(0, 2).toString()).toBe('PK');
  }, 30_000);
});
