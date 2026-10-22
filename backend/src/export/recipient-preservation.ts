import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { ProtectedReceipt } from '../integrity/envelope-jobs.js';
import { DomainError } from '../domain/errors.js';

export const RECIPIENT_PROTECTION_PROFILE = 'packproof.recipient-protection.v1' as const;
export const RECIPIENT_FILE_MAX_BYTES = 12 * 1024 * 1024;
export const RECIPIENT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export interface RecipientProtection {
  profile: typeof RECIPIENT_PROTECTION_PROFILE;
  bucket: string;
  retainUntil: string;
}
/** Only the worker receives a write-capable adapter. API/restore use exact reads. */
export interface RecipientArtifactReader {
  read(jobId: string, receipt: ProtectedReceipt, policy: RecipientProtection): Promise<Buffer>;
}
export interface RecipientArtifactStore extends RecipientArtifactReader {
  preserveFile(jobId: string, bytes: Buffer, contentType: string, policy: RecipientProtection): Promise<ProtectedReceipt>;
  findArtifact(jobId: string, policy: RecipientProtection): Promise<{ bytes: Buffer; receipt: ProtectedReceipt } | null>;
  preserveArtifact(jobId: string, bytes: Buffer, policy: RecipientProtection): Promise<{ bytes: Buffer; receipt: ProtectedReceipt }>;
}
export interface RecipientPreservationRuntime {
  writerGeneration: string;
  assertReady?: () => void;
  /** Reviewed deployment policy, never inferred from a request or bucket default. */
  policy: RecipientProtection;
  reader: RecipientArtifactReader;
  writer?: RecipientArtifactStore;
}
export const recipientRequestOperation = (jobId: string) => `recipient-request:${jobId}`;
export const recipientResultOperation = (jobId: string) => `recipient-result:${jobId}`;
export const recipientApprovalOperation = (jobId: string) => `recipient-approval:${jobId}`;
export function recipientArtifactKey(jobId: string) { return `${recipientObjectPrefix(jobId)}artifact.json`; }
export function recipientObjectPrefix(jobId: string) {
  if (!/^rex_[A-Za-z0-9_-]{1,160}$/.test(jobId)) throw new DomainError('EXPORT_PROTECTION_IDENTITY', 'Invalid protected export identity.', 409);
  return `recipient-exports/v2/${jobId}/`;
}
export function validateRecipientProtection(policy: RecipientProtection, clock: Clock) {
  if (policy?.profile !== RECIPIENT_PROTECTION_PROFILE || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(policy.bucket) ||
      !Number.isFinite(Date.parse(policy.retainUntil)) || new Date(policy.retainUntil).toISOString() !== policy.retainUntil ||
      Date.parse(policy.retainUntil) <= clock.now().getTime())
    throw new DomainError('EXPORT_PROTECTION_UNAVAILABLE', 'A current reviewed export preservation policy is required.', 503);
}
export function validateRecipientReceipt(jobId: string, receipt: ProtectedReceipt, policy: RecipientProtection, artifact = false) {
  const prefix = recipientObjectPrefix(jobId);
  const key = receipt?.object?.key;
  const expectedKey = artifact ? recipientArtifactKey(jobId) : `${prefix}files/${receipt?.sha256}`;
  if (!receipt?.object || receipt.object.bucket !== policy.bucket || key !== expectedKey ||
      typeof receipt.object.versionId !== 'string' || !receipt.object.versionId || receipt.object.versionId === 'null' ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0 ||
      receipt.byteSize > (artifact ? RECIPIENT_ARTIFACT_MAX_BYTES : RECIPIENT_FILE_MAX_BYTES) || receipt.mode !== 'COMPLIANCE' ||
      !Number.isFinite(Date.parse(receipt.verifiedAt)) || !Number.isFinite(Date.parse(receipt.retainUntil)) ||
      Date.parse(receipt.retainUntil) < Date.parse(policy.retainUntil))
    throw new DomainError('EXPORT_PROTECTION_MISMATCH', 'The exact export version lacks matching preservation evidence.', 409);
}
export async function requireRecipientWriter(db: Database, generation: string) {
  await db.query('SELECT pg_advisory_xact_lock(1347438146,36)');
  const fence = (await db.query<{ writes_enabled: boolean; generation: string }>('SELECT writes_enabled,generation FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE')).rows[0];
  if (!generation || !fence?.writes_enabled || fence.generation !== generation)
    throw new DomainError('EXPORT_WRITER_FENCED', 'This export writer is no longer current.', 503);
}
