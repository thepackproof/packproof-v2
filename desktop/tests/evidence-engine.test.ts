import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { EvidenceEngine } from '../src/main/evidence/engine.js';
import { EvidenceStore } from '../src/main/evidence/store.js';
import type { EvidenceTransport, ServerPart, UploadReceipt } from '../src/main/evidence/types.js';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const roots: string[] = [];
const engines: EvidenceEngine[] = [];
const input = { proofId: 'proof_123', label: 'Order #PRIVATE-849', mimeType: 'video/webm;codecs=vp9', camera: 'Packing desk camera', appVersion: '1.0.0', installationId: 'install_123' };
function transport() {
  const parts = new Map<number, ServerPart>();
  const data = new Map<number, Buffer>();
  let expected: UploadReceipt | undefined;
  let committed = false;
  const api = {
    authorizeCapture: vi.fn(async () => ({ maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300 })),
    registerCapture: vi.fn(async (value: Parameters<EvidenceTransport['registerCapture']>[0]) => {
      expected = { sha256: value.sha256, byteSize: value.byteSize };
      return { id: 'cap_123', maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300 };
    }),
    initializeUpload: vi.fn(async () => ({ evidenceId: 'evidence_123' })),
    inspectUpload: vi.fn(async () => committed ? { status: 'COMMITTED' as const, ...expected } : { status: 'PENDING' as const, partSize: 5 * 1024 * 1024, parts: [...parts.values()] }),
    uploadPart: vi.fn(async (value: Parameters<EvidenceTransport['uploadPart']>[0], _signal: AbortSignal) => {
      const receipt = { sha256: hash(value.bytes), byteSize: value.bytes.length, partNumber: value.partNumber };
      parts.set(value.partNumber, receipt); data.set(value.partNumber, Buffer.from(value.bytes)); return receipt;
    }),
    completeUpload: vi.fn(async () => { const bytes = Buffer.concat([...data.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1])); return { sha256: hash(bytes), byteSize: bytes.length }; }),
    commitUpload: vi.fn(async () => { committed = true; return expected!; }),
    attestAndFinalize: vi.fn(async () => undefined),
    discardUpload: vi.fn(async () => undefined),
  } satisfies EvidenceTransport;
  return { api, parts, data, get expected() { return expected; }, setCommitted(value: boolean) { committed = value; } };
}
async function setup() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'packproof-evidence-test-')); roots.push(rootDir);
  const encryptionKey = randomBytes(32); const remote = transport(); let time = Date.parse('2026-09-27T12:00:00Z');
  function newEngine() { const engine = new EvidenceEngine({ rootDir, encryptionKey, api: remote.api, now: () => time, automaticProcessing: false }); engines.push(engine); return engine; }
  const engine = newEngine(); await engine.initialize(); await engine.setAccount('user_A');
  const store = new EvidenceStore(rootDir, encryptionKey);
  return { rootDir, encryptionKey, remote, engine, store, newEngine, advance: (ms: number) => { time += ms; } };
}
async function staged(engine: EvidenceEngine, bytes = Buffer.from('original-continuous-camera-recording')) {
  const capture = await engine.beginCapture(input);
  await engine.appendChunk(capture.id, 0, bytes);
  await engine.finishCapture(capture.id, { attestation: true, recordedDurationMs: 5_000 });
  return capture;
}
async function allFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...await allFiles(path.join(directory, item.name)));
    else result.push(path.join(directory, item.name));
  }
  return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(engines.splice(0).map(engine => engine.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('durable native evidence queue', () => {
  it('persists encrypted chunks during recording, encrypts metadata, and exposes no local paths', async () => {
    const { engine, rootDir } = await setup(); const original = Buffer.from('highly-private-video-original');
    const capture = await engine.beginCapture(input); await engine.appendChunk(capture.id, 0, original);
    for (const file of await allFiles(rootDir)) {
      const bytes = await readFile(file);
      expect(bytes.includes(original)).toBe(false);
      expect(bytes.includes(Buffer.from(input.label))).toBe(false);
      expect(bytes.includes(Buffer.from('user_A'))).toBe(false);
    }
    expect(JSON.stringify(engine.list())).not.toContain(rootDir);
    expect(engine.list()[0]?.byteSize).toBe(original.length);
  });
  it('streams the unchanged original, confirms its server hash, finalizes only after commit, and retains it for 24 hours', async () => {
    const { engine, remote, store, advance } = await setup(); const original = randomBytes(5 * 1024 * 1024 + 921);
    const capture = await staged(engine, original); await engine.processQueue();
    expect(engine.list()[0]).toMatchObject({ state: 'COMPLETE', sha256: hash(original), progress: 100, localCopyAvailable: true });
    expect(Buffer.concat([...remote.data.values()]).equals(original)).toBe(true);
    expect(remote.api.attestAndFinalize.mock.invocationCallOrder[0]).toBeGreaterThan(remote.api.commitUpload.mock.invocationCallOrder[0]!);
    advance(24 * 60 * 60_000 - 1); await engine.cleanup();
    expect((await store.readChunk('user_A', capture.id, 0)).equals(original)).toBe(true);
    advance(1); await engine.cleanup();
    expect(engine.list()[0]?.localCopyAvailable).toBe(false);
    await expect(store.readChunk('user_A', capture.id, 0)).rejects.toThrow();
  });
  it('survives restart offline and resumes only finished recordings', async () => {
    const { engine, newEngine, remote } = await setup(); const capture = await staged(engine);
    remote.api.registerCapture.mockRejectedValueOnce(new TypeError('Network failed'));
    await engine.processQueue(); expect(engine.list()[0]?.state).toBe('WAITING_FOR_NETWORK');
    await engine.shutdown();
    const recovered = newEngine(); await recovered.initialize(); await recovered.setAccount('user_A');
    expect(recovered.list()[0]?.id).toBe(capture.id);
    await recovered.retry(capture.id); await recovered.processQueue();
    expect(recovered.list()[0]?.state).toBe('COMPLETE');
  });
  it('recovers an unfinished capture as interrupted and never uploads it as continuous evidence', async () => {
    const { engine, newEngine, remote, store } = await setup(); const capture = await engine.beginCapture(input);
    await engine.appendChunk(capture.id, 0, Buffer.from('partial-original'));
    // A second process simulates reading the fully fsynced journal after a crash.
    const recovered = newEngine(); await recovered.initialize(); await recovered.setAccount('user_A');
    expect(recovered.list()[0]?.state).toBe('INTERRUPTED');
    await recovered.processQueue(); expect(remote.api.initializeUpload).not.toHaveBeenCalled();
    await expect(recovered.retry(capture.id)).rejects.toThrow('cannot be retried');
    expect(await store.readChunk('user_A', capture.id, 0)).toEqual(Buffer.from('partial-original'));
  });
  it('resumes uploaded parts after a lost response without duplicating accepted bytes', async () => {
    const { engine, remote } = await setup(); const capture = await staged(engine, randomBytes(5 * 1024 * 1024 + 100));
    const originalUpload = remote.api.uploadPart.getMockImplementation()!;
    remote.api.uploadPart.mockImplementationOnce(async (value, signal) => { await originalUpload(value, signal); throw new TypeError('Response lost'); });
    await engine.processQueue(); expect(engine.list()[0]?.state).toBe('WAITING_FOR_NETWORK');
    await engine.retry(capture.id); await engine.processQueue();
    expect(engine.list()[0]?.state).toBe('COMPLETE');
    expect(remote.api.uploadPart.mock.calls.map(call => call[0].partNumber)).toEqual([1, 2]);
    expect(remote.api.initializeUpload).toHaveBeenCalledTimes(1);
  });
  it('reconciles a server commit whose response was lost and does not reupload', async () => {
    const { engine, remote } = await setup(); const capture = await staged(engine);
    remote.api.commitUpload.mockImplementationOnce(async () => { remote.setCommitted(true); throw new TypeError('Commit response lost'); });
    await engine.processQueue(); await engine.retry(capture.id); await engine.processQueue();
    expect(engine.list()[0]?.state).toBe('COMPLETE');
    expect(remote.api.commitUpload).toHaveBeenCalledTimes(1);
    expect(remote.api.uploadPart).toHaveBeenCalledTimes(1);
    expect(remote.api.attestAndFinalize).toHaveBeenCalledTimes(1);
  });
  it('retains the local original and refuses to finalize or clean up after a server hash mismatch', async () => {
    const { engine, remote, store, advance } = await setup(); const capture = await staged(engine);
    remote.api.commitUpload.mockResolvedValueOnce({ sha256: '0'.repeat(64), byteSize: 35 });
    await engine.processQueue();
    expect(engine.list()[0]).toMatchObject({ state: 'FAILED', errorCode: 'SERVER_INTEGRITY_MISMATCH' });
    expect(remote.api.attestAndFinalize).not.toHaveBeenCalled();
    advance(8 * 24 * 60 * 60_000); await engine.cleanup();
    expect(await store.readChunk('user_A', capture.id, 0)).toBeTruthy();
  });
  it('detects encrypted local byte tampering before any upload authorization', async () => {
    const { engine, rootDir, remote } = await setup(); await staged(engine);
    const chunk = (await allFiles(rootDir)).find(file => file.endsWith('000000.enc'))!;
    const bytes = await readFile(chunk); bytes[bytes.length - 1] ^= 0xff; await writeFile(chunk, bytes);
    await engine.processQueue();
    expect(engine.list()[0]).toMatchObject({ state: 'FAILED', errorCode: 'LOCAL_INTEGRITY', localCopyAvailable: true });
    expect(remote.api.initializeUpload).not.toHaveBeenCalled();
  });
  it('refuses a conflicting already uploaded part and preserves the original', async () => {
    const { engine, remote } = await setup(); await staged(engine);
    remote.parts.set(1, { partNumber: 1, byteSize: 4, sha256: 'f'.repeat(64) });
    await engine.processQueue();
    expect(engine.list()[0]).toMatchObject({ state: 'FAILED', errorCode: 'SERVER_INTEGRITY_MISMATCH' });
    expect(remote.api.uploadPart).not.toHaveBeenCalled();
    expect(remote.api.commitUpload).not.toHaveBeenCalled();
  });
  it('isolates account metadata and forbids cross-account capture/retry/discard access', async () => {
    const { engine, remote } = await setup(); const capture = await staged(engine);
    await engine.setAccount('user_B');
    expect(engine.list()).toEqual([]); expect(await engine.hasOtherAccountEvidence()).toBe(true);
    await expect(engine.retry(capture.id)).rejects.toThrow('unavailable for this account');
    await expect(engine.discard(capture.id)).rejects.toThrow('unavailable for this account');
    await engine.processQueue(); expect(remote.api.registerCapture).not.toHaveBeenCalled();
    await engine.setAccount('user_A'); await engine.processQueue();
    expect(engine.list()[0]?.state).toBe('COMPLETE');
    expect(remote.api.registerCapture.mock.calls[0]?.[0].accountId).toBe('user_A');
  });
  it('aborts an in-flight upload before switching accounts', async () => {
    const { engine, remote } = await setup(); await staged(engine);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    remote.api.uploadPart.mockImplementationOnce(async (_value, signal) => {
      entered(); await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), { once: true }); });
      return { sha256: '', byteSize: 0, partNumber: 1 };
    });
    const worker = engine.processQueue(); await started; await engine.setAccount('user_B'); await worker;
    expect(engine.list()).toEqual([]); expect(remote.api.commitUpload).not.toHaveBeenCalled();
    await engine.setAccount('user_A'); await engine.processQueue(); expect(engine.list()[0]?.state).toBe('COMPLETE');
  });
  it('pauses for expired authentication and resumes only after the owning account signs in', async () => {
    const { engine, remote } = await setup(); await staged(engine);
    remote.api.registerCapture.mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401, code: 'UNAUTHENTICATED' }));
    await engine.processQueue(); expect(engine.list()[0]?.state).toBe('WAITING_FOR_AUTH');
    await engine.processQueue(); expect(remote.api.registerCapture).toHaveBeenCalledTimes(1);
    await engine.setAccount('user_A'); await engine.processQueue(); expect(engine.list()[0]?.state).toBe('COMPLETE');
  });
  it('makes chunk retries idempotent but rejects changed and out-of-order bytes', async () => {
    const { engine } = await setup(); const capture = await engine.beginCapture(input);
    await engine.appendChunk(capture.id, 0, Buffer.from('original'));
    await engine.appendChunk(capture.id, 0, Buffer.from('original'));
    expect(engine.list()[0]?.byteSize).toBe(8);
    await expect(engine.appendChunk(capture.id, 0, Buffer.from('changed!'))).rejects.toThrow('has changed');
    await expect(engine.appendChunk(capture.id, 2, Buffer.from('future'))).rejects.toThrow('is missing');
  });
  it('persists explicit discard and never resumes or exposes discarded bytes', async () => {
    const { engine, store, newEngine, remote } = await setup(); const capture = await staged(engine);
    await engine.discard(capture.id); expect(engine.list()).toEqual([]);
    await expect(store.readChunk('user_A', capture.id, 0)).rejects.toThrow();
    const recovered = newEngine(); await recovered.initialize(); await recovered.setAccount('user_A'); await recovered.processQueue();
    expect(recovered.list()).toEqual([]); expect(remote.api.uploadPart).not.toHaveBeenCalled();
  });
  it('never deletes a committed original when finalization fails', async () => {
    const { engine, remote, store, advance } = await setup(); const capture = await staged(engine);
    remote.api.attestAndFinalize.mockRejectedValueOnce(Object.assign(new Error('policy conflict'), { status: 409, code: 'FULFILLMENT_CAPTURE_REQUIRED' }));
    await engine.processQueue(); expect(engine.list()[0]?.state).toBe('FAILED');
    advance(30 * 24 * 60 * 60_000); await engine.cleanup();
    expect(await store.readChunk('user_A', capture.id, 0)).toBeTruthy();
    await expect(engine.discard(capture.id)).rejects.toThrow('cannot be discarded');
    await engine.retry(capture.id); await engine.processQueue();
    expect(engine.list()[0]?.state).toBe('COMPLETE'); expect(remote.api.commitUpload).toHaveBeenCalledTimes(1);
  });
  it('serializes overlapping account changes and hides old data immediately', async () => {
    const { engine, remote } = await setup(); const capture = await staged(engine);
    const first = engine.setAccount(null), second = engine.setAccount('user_A'), third = engine.setAccount('user_B');
    expect(engine.list()).toEqual([]);
    await expect(engine.retry(capture.id)).rejects.toThrow('finish signing in');
    await Promise.all([first, second, third]);
    expect(engine.list()).toEqual([]); await engine.processQueue(); expect(remote.api.uploadPart).not.toHaveBeenCalled();
    await engine.setAccount('user_A'); expect(engine.list()[0]?.id).toBe(capture.id);
  });
  it('preserves prior durable bytes and marks capture interrupted when the disk becomes full', async () => {
    const { engine, store, remote } = await setup(); const capture = await engine.beginCapture(input);
    await engine.appendChunk(capture.id, 0, Buffer.from('durable-first-chunk'));
    vi.spyOn(EvidenceStore.prototype, 'writeChunk').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(engine.appendChunk(capture.id, 1, Buffer.from('cannot-save'))).rejects.toThrow('disk full');
    expect(engine.list()[0]).toMatchObject({ state: 'INTERRUPTED', errorCode: 'DISK_WRITE_FAILED' });
    expect((await store.readChunk('user_A', capture.id, 0)).toString()).toBe('durable-first-chunk');
    await engine.processQueue(); expect(remote.api.uploadPart).not.toHaveBeenCalled();
  });
  it('keeps actual capture stop time when the seller reviews a recording later', async () => {
    const { engine, remote, advance } = await setup(); const capture = await engine.beginCapture(input);
    await engine.appendChunk(capture.id, 0, Buffer.from('recorded bytes')); advance(10 * 60_000);
    await engine.finishCapture(capture.id, { attestation: true, recordedDurationMs: 5_000, startedAt: '2026-09-27T12:00:00.000Z', endedAt: '2026-09-27T12:00:05.000Z' });
    await engine.processQueue();
    expect(remote.api.registerCapture.mock.calls[0]?.[0].metadata.endedAt).toBe('2026-09-27T12:00:05.000Z');
    expect(engine.list()[0]?.state).toBe('COMPLETE');
  });
  it('pauses background transfers and resumes without discarding queued bytes', async () => {
    const { engine, remote } = await setup(); await staged(engine);
    await engine.pause(); await engine.processQueue(); expect(remote.api.uploadPart).not.toHaveBeenCalled();
    await engine.resume(); expect(engine.list()[0]?.state).toBe('COMPLETE');
  });
  it('surfaces a missing desktop backend capability and retains evidence until a later retry', async () => {
    const { engine, remote, advance } = await setup(); await staged(engine);
    remote.api.registerCapture.mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'DESKTOP_CAPTURE_UNSUPPORTED', status: 409 }));
    await engine.processQueue(); advance(7 * 24 * 60 * 60_000); await engine.cleanup();
    expect(engine.list()[0]).toMatchObject({ state: 'FAILED', localCopyAvailable: true, errorCode: 'DESKTOP_CAPTURE_UNSUPPORTED' });
    expect(engine.list()[0]?.error).toContain('desktop recording update');
    expect(remote.api.uploadPart).not.toHaveBeenCalled();
  });
});
