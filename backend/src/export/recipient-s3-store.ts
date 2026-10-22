import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { EnvelopeS3Transport } from '../integrity/envelope-s3-store.js';
import type { ProtectedReceipt } from '../integrity/envelope-jobs.js';
import { DomainError } from '../domain/errors.js';
import { RECIPIENT_ARTIFACT_MAX_BYTES, RECIPIENT_FILE_MAX_BYTES, recipientArtifactKey, recipientObjectPrefix,
  validateRecipientProtection, validateRecipientReceipt, type RecipientArtifactStore, type RecipientProtection } from './recipient-preservation.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const failure = () => new DomainError('EXPORT_PROTECTION_MISMATCH', 'The protected export object could not be verified.', 409);
/** Conditional, bounded, exact-version storage. No copy/delete/retention mutation. */
export function createRecipientS3Store(input: { bucket: string; expectedBucketOwner: string; clock: Clock; transport: EnvelopeS3Transport }): RecipientArtifactStore {
  if (!/^[0-9]{12}$/.test(input.expectedBucketOwner)) throw failure();
  const base = (key: string) => ({ Bucket: input.bucket, Key: key, ExpectedBucketOwner: input.expectedBucketOwner });
  function policyCheck(policy: RecipientProtection) { validateRecipientProtection(policy, input.clock); if (policy.bucket !== input.bucket) throw failure(); }
  async function exact(key: string, versionId: string, policy: RecipientProtection, maximum: number) {
    policyCheck(policy);
    if (!versionId || versionId === 'null') throw failure();
    const reference = { ...base(key), VersionId: versionId };
    const result = await input.transport.get(reference);
    const body = result.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    try {
      if (result.VersionId !== versionId || !body?.[Symbol.asyncIterator] || !Number.isSafeInteger(result.ContentLength) ||
          result.ContentLength! <= 0 || result.ContentLength! > maximum) throw failure();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of body) { size += chunk.byteLength; if (size > maximum) throw failure(); chunks.push(Buffer.from(chunk)); }
      if (size !== result.ContentLength) throw failure();
      const bytes = Buffer.concat(chunks), retention = (await input.transport.retention(reference)).Retention;
      if (retention?.Mode !== 'COMPLIANCE' || !retention.RetainUntilDate || retention.RetainUntilDate.getTime() < Date.parse(policy.retainUntil)) throw failure();
      const receipt: ProtectedReceipt = { object: { bucket: input.bucket, key, versionId }, sha256: hash(bytes), byteSize: bytes.length,
        mode: 'COMPLIANCE', retainUntil: retention.RetainUntilDate.toISOString(), verifiedAt: input.clock.now().toISOString() };
      return { bytes, receipt };
    } finally { body?.destroy?.(); }
  }
  async function find(key: string, policy: RecipientProtection, maximum: number) {
    policyCheck(policy);
    let version: string | undefined;
    try { version = (await input.transport.head(base(key))).VersionId; }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw error; }
    return exact(key, version!, policy, maximum);
  }
  async function put(key: string, bytes: Buffer, contentType: string, policy: RecipientProtection, maximum: number) {
    policyCheck(policy);
    if (!bytes.length || bytes.length > maximum) throw failure();
    try {
      const created = await input.transport.put({ ...base(key), Body: bytes, ContentLength: bytes.length, ContentType: contentType,
        IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64') });
      return exact(key, created.VersionId!, policy, maximum);
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      const winner = await find(key, policy, maximum); if (!winner) throw failure(); return winner;
    }
  }
  return {
    preserveFile: async (jobId, bytes, contentType, policy) => {
      if (!['image/png', 'image/jpeg', 'application/pdf'].includes(contentType)) throw failure();
      const sha256 = hash(bytes), key = `${recipientObjectPrefix(jobId)}files/${sha256}`;
      const saved = await put(key, bytes, contentType, policy, RECIPIENT_FILE_MAX_BYTES);
      validateRecipientReceipt(jobId, saved.receipt, policy);
      if (saved.receipt.sha256 !== sha256 || saved.receipt.byteSize !== bytes.length) throw failure();
      return saved.receipt;
    },
    findArtifact: (jobId, policy) => find(recipientArtifactKey(jobId), policy, RECIPIENT_ARTIFACT_MAX_BYTES),
    preserveArtifact: async (jobId, bytes, policy) => {
      const saved = await put(recipientArtifactKey(jobId), bytes, 'application/json', policy, RECIPIENT_ARTIFACT_MAX_BYTES);
      validateRecipientReceipt(jobId, saved.receipt, policy, true);
      // The caller validates the first published artifact against the accepted request.
      return saved;
    },
    read: async (jobId, receipt, policy) => {
      const artifact = receipt?.object?.key === recipientArtifactKey(jobId);
      validateRecipientReceipt(jobId, receipt, policy, artifact);
      const saved = await exact(receipt.object.key, receipt.object.versionId, policy, receipt.byteSize);
      if (saved.receipt.sha256 !== receipt.sha256 || saved.receipt.byteSize !== receipt.byteSize) throw failure();
      return saved.bytes;
    },
  };
}
