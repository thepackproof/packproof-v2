import { createHash, randomUUID } from 'node:crypto';
import { EvidenceStore, MAX_CHUNK_BYTES, MAX_DURATION_SECONDS, MAX_EVIDENCE_BYTES } from './store.js';
import type { CaptureFinish, CaptureInput, CaptureMetadata, EvidenceEngineOptions, EvidenceJobView, EvidenceState, ServerPart, UploadReceipt } from './types.js';

const PART_BYTES = 5 * 1024 * 1024;
const STATEMENT = 'The item shown and attached in this Proof is the item I am shipping.';
const RUNNABLE = new Set<EvidenceState>(['LOCAL', 'HASHING', 'READY', 'UPLOADING', 'VERIFYING', 'COMMITTING', 'FINALIZING', 'RETRYING', 'WAITING_FOR_NETWORK']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface Chunk { sequence: number; byteSize: number; sha256: string }
interface Job {
  version: 1;
  id: string;
  accountId: string;
  proofId: string;
  label: string;
  mimeType: string;
  state: EvidenceState;
  chunks: Chunk[];
  byteSize: number;
  uploadedBytes: number;
  metadata: CaptureMetadata;
  captureSessionId?: string;
  evidenceId?: string;
  sha256?: string;
  attestation: boolean;
  recordedDurationMs?: number;
  maxRecordingBytes: number;
  maxRecordingSeconds: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  confirmedAt?: string;
  confirmedReceipt?: UploadReceipt;
  error?: string;
  errorCode?: string;
  attempts: number;
  retryAt?: number;
  localCopyAvailable: boolean;
}
export class EvidenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'EvidenceError'; }
}
function fail(code: string, message: string): never { throw new EvidenceError(code, message); }
function boundedText(value: unknown, maximum: number, required = true): string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) || /[\u0000-\u0008]/.test(value)) fail('INVALID_INPUT', 'Invalid recording details.');
  return value;
}

/** One native worker, authenticated encryption, durable acknowledgements and server reconciliation. */
export class EvidenceEngine {
  private readonly store: EvidenceStore;
  private readonly options: EvidenceEngineOptions;
  private accountId: string | null = null;
  private jobs = new Map<string, Job>();
  private writes = new Map<string, Promise<unknown>>();
  private outstandingChunkBytes = 0;
  private controller?: AbortController;
  private worker?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private paused = false;
  private retentionMs = 24 * 60 * 60 * 1000;
  private accountEpoch = 0;
  private accountTransitions = 0;
  private accountSwitch: Promise<void> = Promise.resolve();
  private beginPending = false;
  private unreadableJobs = 0;
  constructor(options: EvidenceEngineOptions) { this.options = options; this.store = new EvidenceStore(options.rootDir, options.encryptionKey); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private date(): string { return new Date(this.now()).toISOString(); }
  async initialize(): Promise<void> {
    await this.store.initialize();
    if (this.options.automaticProcessing !== false) {
      this.timer = setInterval(() => { void this.processQueue().catch(() => undefined); }, 5_000);
      this.timer.unref?.();
    }
  }
  get activeCapture(): boolean { return this.beginPending || [...this.jobs.values()].some(job => job.state === 'RECORDING' || job.state === 'AUTHORIZING'); }
  get hasPending(): boolean { return [...this.jobs.values()].some(job => !['COMPLETE', 'DISCARDED'].includes(job.state)); }
  get unreadableJobCount(): number { return this.unreadableJobs; }
  private emit(): void {
    if (!this.accountTransitions) {
      // UI/notification failures must never change a durable evidence outcome.
      try { this.options.onChange?.(this.list()); } catch { /* Observer is advisory. */ }
    }
  }
  private view(job: Job): EvidenceJobView {
    return { id: job.id, proofId: job.proofId, label: job.label, state: job.state, byteSize: job.byteSize,
      uploadedBytes: job.uploadedBytes, progress: job.state === 'COMPLETE' ? 100 : job.byteSize ? Math.min(99, Math.floor(job.uploadedBytes / job.byteSize * 100)) : 0,
      createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt, error: job.error, errorCode: job.errorCode,
      evidenceId: job.evidenceId, sha256: job.sha256, maxRecordingBytes: job.maxRecordingBytes, maxRecordingSeconds: job.maxRecordingSeconds,
      localCopyAvailable: job.localCopyAvailable };
  }
  list(): EvidenceJobView[] { return this.accountTransitions ? [] : [...this.jobs.values()].filter(job => job.accountId === this.accountId && job.state !== 'DISCARDED').map(job => this.view(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async hasOtherAccountEvidence(): Promise<boolean> { return this.accountId ? this.store.hasOtherAccounts(this.accountId) : false; }
  async storageStats(): Promise<{ availableBytes: number; stagedBytes: number; unreadableJobs: number }> {
    const availableBytes = await this.store.availableBytes();
    return { availableBytes, stagedBytes: this.accountTransitions ? 0 : [...this.jobs.values()].filter(job => job.accountId === this.accountId && job.localCopyAvailable).reduce((sum, job) => sum + job.byteSize, 0), unreadableJobs: this.accountTransitions ? 0 : this.unreadableJobs };
  }
  private async serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.writes.set(id, current);
    try { return await current; } finally { if (this.writes.get(id) === current) this.writes.delete(id); }
  }
  private async save(job: Job): Promise<void> {
    job.updatedAt = this.date();
    await this.store.writeJournal(job.accountId, job.id, job);
    if (job.accountId === this.accountId) this.emit();
  }
  private ownJob(id: string): Job {
    if (this.accountTransitions) fail('ACCOUNT_CHANGED', 'Wait for this account to finish signing in.');
    const job = this.jobs.get(id);
    if (!this.accountId || !job || job.accountId !== this.accountId) fail('JOB_NOT_FOUND', 'This recording is unavailable for this account.');
    return job;
  }
  private assertActive(job: Job, signal?: AbortSignal): void {
    if (signal?.aborted || this.stopped || this.accountId !== job.accountId) throw new DOMException('Queue paused', 'AbortError');
  }
  async setAccount(accountId: string | null): Promise<void> {
    if (accountId !== null) boundedText(accountId, 200);
    ++this.accountEpoch;
    ++this.accountTransitions;
    this.controller?.abort();
    const operation = this.accountSwitch.catch(() => undefined).then(() => this.switchAccount(accountId));
    this.accountSwitch = operation;
    try { await operation; }
    finally {
      --this.accountTransitions;
      if (!this.accountTransitions) {
        this.emit();
        if (this.options.automaticProcessing !== false) void this.processQueue().catch(() => undefined);
      }
    }
  }
  private async switchAccount(accountId: string | null): Promise<void> {
    this.controller?.abort();
    await this.worker?.catch(() => undefined);
    await Promise.allSettled([...this.writes.values()]);
    for (const job of this.jobs.values()) {
      if (job.state === 'RECORDING' || job.state === 'AUTHORIZING') {
        job.state = 'INTERRUPTED'; job.error = 'Recording interrupted. The local original is preserved; start a new continuous recording.';
        job.errorCode = 'CAPTURE_INTERRUPTED'; await this.save(job);
      }
    }
    this.accountId = accountId;
    this.jobs.clear(); this.unreadableJobs = 0;
    if (accountId) {
      for (const id of await this.store.listIds(accountId)) {
        try {
          const job: Job = await this.store.readJournal<Job>(accountId, id);
          if (job.version !== 1 || job.id !== id || job.accountId !== accountId || !Array.isArray(job.chunks)) throw new Error('LOCAL_INTEGRITY');
          this.jobs.set(id, job);
          if (job.state === 'RECORDING' || job.state === 'AUTHORIZING') {
            job.state = 'INTERRUPTED'; job.errorCode = 'CAPTURE_INTERRUPTED';
            job.error = 'The application stopped during recording. The partial original is preserved; record a new continuous video.';
            await this.save(job);
          } else if (job.state === 'WAITING_FOR_AUTH') { job.state = 'READY'; job.retryAt = 0; await this.save(job); }
        } catch { this.unreadableJobs++; }
      }
    }
  }
  async beginCapture(input: CaptureInput): Promise<EvidenceJobView> {
    if (!this.accountId || this.stopped || this.accountTransitions) fail('AUTH_REQUIRED', 'Sign in before recording.');
    if (this.activeCapture) fail('CAPTURE_ACTIVE', 'Finish the current recording first.');
    const proofId = boundedText(input.proofId, 200);
    const mimeType = boundedText(input.mimeType, 150).split(';')[0]!.trim().toLowerCase();
    if (!['video/webm', 'video/mp4', 'video/quicktime'].includes(mimeType)) fail('INVALID_CONTENT_TYPE', 'This camera recording format is unsupported.');
    const appVersion = boundedText(input.appVersion, 100);
    const installationId = boundedText(input.installationId, 200);
    const camera = input.camera === undefined ? undefined : boundedText(input.camera, 300, false);
    const label = input.label === undefined ? 'Packing recording' : boundedText(input.label, 300);
    const accountId = this.accountId, epoch = this.accountEpoch;
    this.beginPending = true;
    try {
      if (await this.store.availableBytes() < MAX_EVIDENCE_BYTES + 64 * 1024 * 1024) fail('DISK_SPACE_LOW', 'Free at least 320 MB on this computer before recording.');
      if (epoch !== this.accountEpoch || accountId !== this.accountId) fail('ACCOUNT_CHANGED', 'Sign in again before recording.');
      const now = this.date();
      const job: Job = { version: 1, id: randomUUID(), accountId, proofId, label, mimeType, state: 'AUTHORIZING', chunks: [], byteSize: 0, uploadedBytes: 0,
        metadata: { captureSource: 'DESKTOP_CAMERA', camera, appVersion, installationId, platform: process.platform, offline: input.offline === true, startedAt: now, detections: [], provenance: 'CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED' },
        attestation: false, maxRecordingBytes: MAX_EVIDENCE_BYTES, maxRecordingSeconds: MAX_DURATION_SECONDS, createdAt: now, updatedAt: now, attempts: 0, localCopyAvailable: true };
      await this.save(job);
      if (epoch !== this.accountEpoch || accountId !== this.accountId) fail('ACCOUNT_CHANGED', 'Sign in again before recording.');
      this.jobs.set(job.id, job);
      try {
        const authorization = await this.options.api.authorizeCapture({ accountId, proofId, jobId: job.id }, new AbortController().signal);
        if (epoch !== this.accountEpoch || accountId !== this.accountId) fail('ACCOUNT_CHANGED', 'Sign in again before recording.');
        job.captureSessionId = authorization.id;
        job.maxRecordingBytes = Math.min(MAX_EVIDENCE_BYTES, authorization.maxRecordingBytes);
        job.maxRecordingSeconds = Math.min(MAX_DURATION_SECONDS, authorization.maxRecordingSeconds);
        if (!(job.maxRecordingBytes > 0) || !(job.maxRecordingSeconds > 0)) fail('INVALID_SERVER_RESPONSE', 'Recording limits are unavailable.');
        job.state = 'RECORDING'; await this.save(job);
        return this.view(job);
      } catch (error) {
        job.state = 'FAILED'; job.error = 'Recording could not start. No recording bytes were discarded.';
        job.errorCode = (error as { code?: string }).code ?? 'CAPTURE_START_FAILED'; await this.save(job); throw error;
      }
    } finally { this.beginPending = false; }
  }
  async appendChunk(id: string, sequence: number, data: Uint8Array): Promise<{ sequence: number; byteSize: number }> {
    const job = this.ownJob(id);
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_CHUNK_BYTES || !Number.isSafeInteger(sequence) || sequence < 0) fail('INVALID_CHUNK', 'The recording chunk is invalid.');
    if (this.outstandingChunkBytes + data.byteLength > MAX_CHUNK_BYTES * 2) fail('CAPTURE_BACKPRESSURE', 'The recording disk cannot keep up. Stop and preserve this recording.');
    this.outstandingChunkBytes += data.byteLength;
    const bytes = Buffer.from(data);
    try {
      return await this.serialized(id, async () => {
        this.assertActive(job);
        if (job.state !== 'RECORDING') fail('CAPTURE_CLOSED', 'This recording is no longer accepting bytes.');
        const sha256 = digest(bytes);
        if (sequence < job.chunks.length) {
          const previous = job.chunks[sequence]!;
          if (previous.sha256 !== sha256 || previous.byteSize !== bytes.length) fail('CHUNK_CONFLICT', 'This recording chunk has changed. The original is preserved.');
          return { sequence, byteSize: job.byteSize };
        }
        if (sequence !== job.chunks.length) fail('CHUNK_OUT_OF_ORDER', 'A recording chunk is missing.');
        if (job.chunks.length >= 4096) fail('CHUNK_LIMIT', 'The recording produced too many fragments. Existing local bytes are preserved.');
        if (job.byteSize + bytes.length > job.maxRecordingBytes) fail('RECORDING_LIMIT', 'This recording reached the maximum file size.');
        try {
          await this.store.writeChunk(job.accountId, job.id, sequence, bytes);
          job.chunks.push({ sequence, byteSize: bytes.length, sha256 }); job.byteSize += bytes.length;
          await this.save(job);
        } catch (error) {
          job.state = 'INTERRUPTED'; job.errorCode = 'DISK_WRITE_FAILED'; job.error = 'The recording could not be saved completely. Existing local bytes are preserved.';
          await this.save(job).catch(() => undefined); throw error;
        }
        return { sequence, byteSize: job.byteSize };
      });
    } finally { this.outstandingChunkBytes -= data.byteLength; }
  }
  async finishCapture(id: string, input: CaptureFinish): Promise<EvidenceJobView> {
    const job = this.ownJob(id);
    const result = await this.serialized(id, async () => {
      this.assertActive(job);
      if (job.state !== 'RECORDING') fail('CAPTURE_CLOSED', 'This recording cannot be completed.');
      if (!job.byteSize) fail('EMPTY_RECORDING', 'No recording bytes have been saved.');
      if (input.attestation !== true) fail('ATTESTATION_REQUIRED', 'Confirm that the item shown is the item you are shipping.');
      const duration = input.recordedDurationMs ?? Math.max(0, this.now() - Date.parse(job.createdAt));
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > job.maxRecordingSeconds * 1000) fail('RECORDING_LIMIT', 'The recording exceeded its duration limit. The original remains on this computer.');
      const startedAt = input.startedAt === undefined ? job.metadata.startedAt : boundedText(input.startedAt, 40);
      const startMs = Date.parse(startedAt);
      if (!Number.isFinite(startMs)) fail('INVALID_CAPTURE_TIMING', 'The recording start timestamp is invalid. The local original is preserved.');
      const endedAt = input.endedAt === undefined ? new Date(startMs + duration).toISOString() : boundedText(input.endedAt, 40);
      const endMs = Date.parse(endedAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > job.maxRecordingSeconds * 1000 || Math.abs(endMs - startMs - duration) > 2_000) fail('INVALID_CAPTURE_TIMING', 'The recording timestamps are inconsistent. The local original is preserved.');
      const detections = input.detections ?? [];
      if (!Array.isArray(detections) || detections.length > 500) fail('INVALID_DETECTIONS', 'Too many label observations.');
      job.metadata.detections = detections.map(detection => {
        if (!Number.isSafeInteger(detection.detectedAtMs) || detection.detectedAtMs < 0 || detection.detectedAtMs > duration) fail('INVALID_DETECTIONS', 'A label observation is outside the recording.');
        if (detection.confirmed !== undefined && typeof detection.confirmed !== 'boolean' || detection.notThisPackage !== undefined && typeof detection.notThisPackage !== 'boolean' || detection.confirmed && detection.notThisPackage) fail('INVALID_DETECTIONS', 'The label confirmation is invalid.');
        return { value: boundedText(detection.value, 1024), format: detection.format === undefined ? undefined : boundedText(detection.format, 80), detectedAtMs: detection.detectedAtMs, confirmed: detection.confirmed, notThisPackage: detection.notThisPackage };
      });
      job.metadata.startedAt = new Date(startMs).toISOString(); job.metadata.endedAt = new Date(endMs).toISOString(); job.recordedDurationMs = duration; job.attestation = true; job.state = 'LOCAL';
      await this.save(job); return this.view(job);
    });
    if (this.options.automaticProcessing !== false) setImmediate(() => { void this.processQueue().catch(() => undefined); });
    return result;
  }
  async interruptCapture(id: string, reason = 'Recording interrupted. Start a new continuous video.'): Promise<EvidenceJobView> {
    const job = this.ownJob(id);
    return this.serialized(id, async () => {
      if (job.state !== 'RECORDING') return this.view(job);
      job.state = 'INTERRUPTED'; job.errorCode = 'CAPTURE_INTERRUPTED'; job.error = boundedText(reason, 300);
      await this.save(job); return this.view(job);
    });
  }
  async interruptActiveCapture(reason: string): Promise<void> {
    const job = [...this.jobs.values()].find(item => item.state === 'RECORDING');
    if (job) await this.interruptCapture(job.id, reason);
  }
  async pause(): Promise<void> {
    this.paused = true; this.controller?.abort(); await this.worker?.catch(() => undefined);
  }
  async resume(): Promise<void> { this.paused = false; await this.processQueue(); }
  setRetentionHours(hours: 0 | 24 | 168): void {
    if (![0, 24, 168].includes(hours)) fail('INVALID_RETENTION', 'Select a supported local retention period.');
    this.retentionMs = hours * 60 * 60 * 1000;
  }
  private async *originalBytes(job: Job): AsyncGenerator<Buffer> {
    let total = 0;
    for (let sequence = 0; sequence < job.chunks.length; sequence++) {
      const chunk = job.chunks[sequence]!;
      if (chunk.sequence !== sequence) fail('LOCAL_INTEGRITY', 'The saved recording sequence is incomplete.');
      let bytes: Buffer;
      try { bytes = await this.store.readChunk(job.accountId, job.id, sequence); }
      catch { fail('LOCAL_INTEGRITY', 'The saved recording is missing or failed its integrity check. Its remaining bytes are preserved.'); }
      if (bytes.length !== chunk.byteSize || digest(bytes) !== chunk.sha256) fail('LOCAL_INTEGRITY', 'The saved recording failed its integrity check.');
      total += bytes.length; yield bytes;
    }
    if (total !== job.byteSize || total < 1) fail('LOCAL_INTEGRITY', 'The saved recording is incomplete.');
  }
  private async hashOriginal(job: Job): Promise<string> {
    const hash = createHash('sha256');
    for await (const bytes of this.originalBytes(job)) hash.update(bytes);
    return hash.digest('hex');
  }
  private async *parts(job: Job): AsyncGenerator<{ partNumber: number; bytes: Buffer; sha256: string }> {
    let partNumber = 1, used = 0, part = Buffer.allocUnsafe(PART_BYTES);
    for await (const chunk of this.originalBytes(job)) {
      let offset = 0;
      while (offset < chunk.length) {
        const length = Math.min(PART_BYTES - used, chunk.length - offset);
        chunk.copy(part, used, offset, offset + length); used += length; offset += length;
        if (used === PART_BYTES) { yield { partNumber: partNumber++, bytes: part, sha256: digest(part) }; part = Buffer.allocUnsafe(PART_BYTES); used = 0; }
      }
    }
    if (used) { const bytes = part.subarray(0, used); yield { partNumber, bytes, sha256: digest(bytes) }; }
  }
  private assertReceipt(receipt: { sha256?: string; byteSize?: number }, expected: UploadReceipt): void {
    if (receipt.sha256?.toLowerCase() !== expected.sha256 || receipt.byteSize !== expected.byteSize) fail('SERVER_INTEGRITY_MISMATCH', 'PackProof has not confirmed the exact original recording. The local original is preserved.');
  }
  private async runJob(job: Job, signal: AbortSignal): Promise<void> {
    const context = { accountId: job.accountId, proofId: job.proofId, jobId: job.id };
    this.assertActive(job, signal);
    if (!job.attestation || !job.metadata.endedAt || job.recordedDurationMs === undefined) fail('INCOMPLETE_CAPTURE', 'An interrupted capture cannot be uploaded as a finished recording.');
    job.error = undefined; job.errorCode = undefined;
    if (!job.confirmedReceipt) {
      job.state = 'HASHING'; await this.save(job);
      const sha256 = await this.hashOriginal(job);
      if (job.sha256 && job.sha256 !== sha256) fail('LOCAL_INTEGRITY', 'The saved recording has changed.');
      job.sha256 = sha256; job.state = 'READY'; await this.save(job);
      this.assertActive(job, signal);
      const registration = await this.options.api.registerCapture({ ...context, captureSessionId: job.captureSessionId, sha256, byteSize: job.byteSize, mimeType: job.mimeType, recordedDurationMs: job.recordedDurationMs, metadata: job.metadata }, signal);
      this.assertActive(job, signal);
      if (!registration.id) fail('INVALID_SERVER_RESPONSE', 'The server did not register this recording.');
      job.captureSessionId = registration.id; await this.save(job);
      if (!job.evidenceId) {
        const initialized = await this.options.api.initializeUpload({ ...context, captureSessionId: job.captureSessionId, mimeType: job.mimeType, sha256, byteSize: job.byteSize }, signal);
        this.assertActive(job, signal); job.evidenceId = boundedText(initialized.evidenceId, 200); await this.save(job);
      }
      const identity = { ...context, evidenceId: job.evidenceId };
      const expected = { sha256, byteSize: job.byteSize };
      const remote = await this.options.api.inspectUpload(identity, signal);
      this.assertActive(job, signal);
      if (remote.status === 'REJECTED') fail('UPLOAD_REJECTED', 'The server rejected this recording. The original remains on this computer.');
      if (remote.status === 'COMMITTED') this.assertReceipt(remote, expected);
      else {
        if (remote.partSize !== PART_BYTES || !Array.isArray(remote.parts)) fail('INVALID_SERVER_RESPONSE', 'The server upload format is unsupported.');
        const remoteParts = new Map<number, ServerPart>();
        for (const part of remote.parts) {
          if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > Math.ceil(job.byteSize / PART_BYTES) || remoteParts.has(part.partNumber)) fail('SERVER_INTEGRITY_MISMATCH', 'The server returned an inconsistent part list.');
          remoteParts.set(part.partNumber, part);
        }
        job.state = 'UPLOADING'; job.uploadedBytes = 0; await this.save(job);
        for await (const part of this.parts(job)) {
          this.assertActive(job, signal);
          const saved = remoteParts.get(part.partNumber);
          if (saved) this.assertReceipt(saved, { byteSize: part.bytes.length, sha256: part.sha256 });
          else {
            const receipt = await this.options.api.uploadPart({ ...identity, ...part }, signal);
            this.assertActive(job, signal); this.assertReceipt(receipt, { byteSize: part.bytes.length, sha256: part.sha256 });
          }
          job.uploadedBytes += part.bytes.length; await this.save(job);
        }
        job.state = 'VERIFYING'; await this.save(job);
        const completed = await this.options.api.completeUpload({ ...identity, ...expected }, signal);
        this.assertActive(job, signal); this.assertReceipt(completed, expected);
        job.state = 'COMMITTING'; await this.save(job);
        const committed = await this.options.api.commitUpload({ ...identity, ...expected }, signal);
        this.assertActive(job, signal); this.assertReceipt(committed, expected);
        const accepted = await this.options.api.inspectUpload(identity, signal);
        this.assertActive(job, signal);
        if (accepted.status !== 'COMMITTED') fail('SERVER_NOT_COMMITTED', 'The server has not yet accepted this recording into the Proof.');
        this.assertReceipt(accepted, expected);
      }
      job.confirmedReceipt = expected; job.confirmedAt = this.date(); job.uploadedBytes = job.byteSize; await this.save(job);
    }
    this.assertActive(job, signal);
    if (!job.evidenceId || !job.captureSessionId) fail('LOCAL_INTEGRITY', 'The local upload record is incomplete.');
    job.state = 'FINALIZING'; await this.save(job);
    await this.options.api.attestAndFinalize({ ...context, evidenceId: job.evidenceId, captureSessionId: job.captureSessionId, statement: STATEMENT }, signal);
    this.assertActive(job, signal);
    job.state = 'COMPLETE'; job.completedAt = this.date(); job.attempts = 0; job.retryAt = undefined; job.error = undefined; job.errorCode = undefined;
    await this.save(job);
    try { this.options.onComplete?.(this.view(job)); } catch { /* OS notifications are advisory. */ }
  }
  private async handleFailure(job: Job, error: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted || (error as Error).name === 'AbortError') {
      job.state = job.confirmedReceipt ? 'FINALIZING' : 'READY';
      await this.save(job); return;
    }
    const failure = error as { code?: string; status?: number; message?: string };
    const status = failure.status;
    const code = failure.code ?? (failure.message === 'LOCAL_INTEGRITY' ? 'LOCAL_INTEGRITY' : 'UPLOAD_UNAVAILABLE');
    job.attempts++;
    job.errorCode = code;
    if (status === 401 || ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'UNAUTHENTICATED'].includes(code)) {
      job.state = 'WAITING_FOR_AUTH'; job.error = 'Sign in with the original account to continue this upload.';
    } else if (['LOCAL_INTEGRITY', 'SERVER_INTEGRITY_MISMATCH', 'INVALID_SERVER_RESPONSE', 'INCOMPLETE_CAPTURE'].includes(code) || (status && status >= 400 && status < 500 && ![408, 429].includes(status))) {
      const messages: Record<string, string> = {
        DESKTOP_CAPTURE_UNSUPPORTED: 'This PackProof server needs the desktop recording update. The original remains secured on this computer; retry after the service is updated.',
        LABEL_REVIEW_REQUIRED: 'Review the labels for this recording in PackProof, then retry completion. The original is preserved.',
        CAPTURE_RECORDING_LIMIT: 'This recording exceeds the account recording allowance. The original remains on this computer.',
        CAPTURE_RECOVERY_EXPIRED: 'The server recovery window has expired. The original is preserved; contact PackProof support.',
        CAPTURE_SESSION_EXPIRED: 'The server recording session has expired. The original is preserved; contact PackProof support.',
        PARTICIPANT_NOT_AUTHORIZED: 'This account no longer has permission for the Proof. The original remains secured on this computer.',
        EVIDENCE_DIGEST_MISMATCH: 'The server has not confirmed the exact original recording. The local original is preserved.',
      };
      job.state = 'FAILED'; job.error = failure instanceof EvidenceError ? failure.message : messages[code] ?? 'This recording needs attention. The original is preserved on this computer.';
    } else if (job.attempts >= 8) {
      job.state = 'FAILED'; job.error = 'Upload retries paused. The recording remains secured locally; retry when the connection is restored.';
    } else {
      job.state = status ? 'RETRYING' : 'WAITING_FOR_NETWORK';
      job.error = 'The recording is secured locally and will retry when PackProof is reachable.';
      job.retryAt = this.now() + Math.min(5 * 60_000, 2_000 * 2 ** (job.attempts - 1));
    }
    await this.save(job);
  }
  async processQueue(): Promise<void> {
    if (this.worker) return this.worker;
    if (!this.accountId || this.stopped || this.paused || this.accountTransitions) return;
    const controller = new AbortController(); this.controller = controller;
    const operation = (async () => {
      for (const job of this.jobs.values()) {
        if (controller.signal.aborted || this.stopped) break;
        if (job.accountId !== this.accountId || !RUNNABLE.has(job.state) || (job.retryAt ?? 0) > this.now()) continue;
        try { await this.runJob(job, controller.signal); }
        catch (error) { await this.handleFailure(job, error, controller.signal); }
      }
      if (!controller.signal.aborted) await this.cleanup();
    })();
    this.worker = operation;
    try { await operation; } finally { if (this.worker === operation) { this.worker = undefined; this.controller = undefined; } }
  }
  async retry(id: string): Promise<EvidenceJobView> {
    const job = this.ownJob(id);
    if (['RECORDING', 'AUTHORIZING', 'INTERRUPTED', 'DISCARDED', 'COMPLETE'].includes(job.state)) fail('RETRY_UNAVAILABLE', 'This recording cannot be retried.');
    this.controller?.abort(); await this.worker?.catch(() => undefined);
    job.attempts = 0; job.retryAt = 0; job.error = undefined; job.errorCode = undefined; job.state = job.confirmedReceipt ? 'FINALIZING' : 'READY';
    await this.save(job);
    if (this.options.automaticProcessing !== false) void this.processQueue().catch(() => undefined);
    return this.view(job);
  }
  async discard(id: string): Promise<void> {
    const job = this.ownJob(id);
    if (job.confirmedReceipt || job.state === 'COMPLETE') fail('ALREADY_COMMITTED', 'Committed evidence cannot be discarded.');
    this.controller?.abort(); await this.worker?.catch(() => undefined);
    await this.serialized(id, async () => {
      this.assertActive(job);
      if (job.confirmedReceipt) fail('ALREADY_COMMITTED', 'Committed evidence cannot be discarded.');
      // Cancellation is persisted before deleting; an app crash cannot resume a discarded job.
      job.state = 'DISCARDED'; job.error = undefined; job.errorCode = undefined; await this.save(job);
      await this.store.removeChunks(job.accountId, job.id); job.localCopyAvailable = false; await this.save(job);
    });
    // Local removal is an explicit user action and remains available while offline.
    if (this.options.api.discardUpload) await this.options.api.discardUpload({ accountId: job.accountId, proofId: job.proofId, jobId: job.id, evidenceId: job.evidenceId, captureSessionId: job.captureSessionId }, new AbortController().signal).catch(() => undefined);
    this.emit();
  }
  async cleanup(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.state !== 'COMPLETE' || !job.confirmedReceipt || !job.confirmedAt || !job.localCopyAvailable) continue;
      if (this.now() - Date.parse(job.confirmedAt) < this.retentionMs) continue;
      this.assertReceipt(job.confirmedReceipt, { sha256: job.sha256!, byteSize: job.byteSize });
      await this.store.removeChunks(job.accountId, job.id); job.localCopyAvailable = false; await this.save(job);
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    this.controller?.abort(); await this.worker?.catch(() => undefined);
    await Promise.allSettled([...this.writes.values()]);
    for (const job of this.jobs.values()) if (job.state === 'RECORDING' || job.state === 'AUTHORIZING') {
      job.state = 'INTERRUPTED'; job.errorCode = 'CAPTURE_INTERRUPTED'; job.error = 'Recording interrupted when the application closed. The original is preserved.'; await this.save(job);
    }
  }
}
