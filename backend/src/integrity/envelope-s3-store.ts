import { createHash } from 'node:crypto';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, GetObjectRetentionCommand,
  type HeadObjectCommandInput, type HeadObjectCommandOutput, type GetObjectCommandInput, type GetObjectCommandOutput,
  type PutObjectCommandInput, type PutObjectCommandOutput, type GetObjectRetentionCommandInput, type GetObjectRetentionCommandOutput } from '@aws-sdk/client-s3';
import type { Clock } from '../clock.js';
import type { ExactObject } from './envelope-profile.js';
import type { EnvelopeStore, ProtectedReceipt } from './envelope-jobs.js';

export interface EnvelopeS3Transport {
  head(input: HeadObjectCommandInput): Promise<HeadObjectCommandOutput>;
  get(input: GetObjectCommandInput): Promise<GetObjectCommandOutput>;
  put(input: PutObjectCommandInput): Promise<PutObjectCommandOutput>;
  retention(input: GetObjectRetentionCommandInput): Promise<GetObjectRetentionCommandOutput>;
}
export function envelopeS3Transport(region: string): EnvelopeS3Transport {
  const client = new S3Client({ region, maxAttempts: 3 });
  const options = () => ({ abortSignal: AbortSignal.timeout(60000) });
  return { head: input => client.send(new HeadObjectCommand(input), options()), get: input => client.send(new GetObjectCommand(input), options()),
    put: input => client.send(new PutObjectCommand(input), options()), retention: input => client.send(new GetObjectRetentionCommand(input), options()) };
}
const check = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const artifactKey = (key: string) => /^integrity\/v1\/(?:manifests|envelopes)\/[a-f0-9]{64}\.json$/.test(key);
/** Separate adapter: it cannot copy originals, select latest media, remove locks,
 * shorten retention or grant itself bucket authority. Protection receipt and IAM
 * review are required before a hosted worker may receive this adapter. */
export function createEnvelopeS3Store(input: {
  artifactBucket: string; evidenceBuckets: string[]; expectedBucketOwner: string;
  clock: Clock; transport: EnvelopeS3Transport;
}): EnvelopeStore {
  check(/^[0-9]{12}$/.test(input.expectedBucketOwner) && input.evidenceBuckets.length > 0, 'ENVELOPE_STORAGE_CONFIGURATION');
  const allowed = new Set([input.artifactBucket, ...input.evidenceBuckets]);
  const exactInput = (object: ExactObject) => {
    check(allowed.has(object.bucket) && typeof object.key === 'string' && object.key.length > 0 && object.key.length <= 1024 && typeof object.versionId === 'string' && object.versionId.length > 0 && object.versionId !== 'null', 'ENVELOPE_EXACT_VERSION_REQUIRED');
    return { Bucket: object.bucket, Key: object.key, VersionId: object.versionId, ExpectedBucketOwner: input.expectedBucketOwner };
  };
  async function read(object: ExactObject, maxBytes: number, collect: boolean) {
    const response = await input.transport.get(exactInput(object));
    const stream = response.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    try {
      check(response.VersionId === object.versionId && stream?.[Symbol.asyncIterator] && Number.isSafeInteger(response.ContentLength) && response.ContentLength! <= maxBytes && response.ContentLength! >= 0, 'ENVELOPE_OBJECT_METADATA_MISMATCH');
      const hash = createHash('sha256'), chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream!) {
        size += chunk.byteLength;
        check(size <= maxBytes, 'ENVELOPE_OBJECT_SIZE_MISMATCH');
        hash.update(chunk); if (collect) chunks.push(Buffer.from(chunk));
      }
      check(size === response.ContentLength, 'ENVELOPE_OBJECT_SIZE_MISMATCH');
      return { sha256: hash.digest('hex'), byteSize: size, body: collect ? Buffer.concat(chunks) : Buffer.alloc(0) };
    } finally { stream?.destroy?.(); }
  }
  async function verify(artifact: { storage: ExactObject; sha256: string; byteSize: number }, retainUntil: string): Promise<ProtectedReceipt> {
    check(Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0 && artifact.byteSize <= 250000000 && /^[a-f0-9]{64}$/.test(artifact.sha256), 'ENVELOPE_OBJECT_BOUND_REQUIRED');
    check(Date.parse(retainUntil) > input.clock.now().getTime(), 'ENVELOPE_RETENTION_EXPIRED');
    const stored = await read(artifact.storage, artifact.byteSize, false);
    check(stored.sha256 === artifact.sha256 && stored.byteSize === artifact.byteSize, 'ENVELOPE_OBJECT_DIGEST_MISMATCH');
    const result = await input.transport.retention(exactInput(artifact.storage));
    const retention = result.Retention;
    check(retention?.Mode === 'COMPLIANCE' && retention.RetainUntilDate && retention.RetainUntilDate.getTime() >= Date.parse(retainUntil), 'ENVELOPE_PROTECTION_MISMATCH');
    return { object: { ...artifact.storage }, sha256: stored.sha256, byteSize: stored.byteSize, mode: 'COMPLIANCE', retainUntil: retention!.RetainUntilDate!.toISOString(), verifiedAt: input.clock.now().toISOString() };
  }
  async function find(bucket: string, key: string, maxBytes: number) {
    check(bucket === input.artifactBucket && artifactKey(key) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 12 * 1024 * 1024, 'ENVELOPE_ARTIFACT_SCOPE');
    let head: HeadObjectCommandOutput;
    try { head = await input.transport.head({ Bucket: bucket, Key: key, ExpectedBucketOwner: input.expectedBucketOwner }); }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw error; }
    const object = { bucket, key, versionId: head.VersionId! };
    const stored = await read(object, maxBytes, true);
    return { body: stored.body, object };
  }
  return { find, verify, preserve: async (bucket, key, bytes, retainUntil) => {
    check(bucket === input.artifactBucket && artifactKey(key) && bytes.length > 0 && bytes.length <= 12 * 1024 * 1024, 'ENVELOPE_ARTIFACT_SCOPE');
    check(Date.parse(retainUntil) > input.clock.now().getTime(), 'ENVELOPE_RETENTION_EXPIRED');
    try {
      const result = await input.transport.put({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/json', ContentLength: bytes.length,
        IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil), ExpectedBucketOwner: input.expectedBucketOwner });
      const storage = { bucket, key, versionId: result.VersionId! };
      return verify({ storage, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }, retainUntil);
    } catch (error) {
      // Only 412 means a different contender won. 409, timeout and lost-response
      // errors retry through find() on the next lease; none imply success.
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      const winner = await find(bucket, key, 12 * 1024 * 1024);
      check(winner, 'ENVELOPE_RESULT_UNAVAILABLE');
      return verify({ storage: winner!.object, sha256: createHash('sha256').update(winner!.body).digest('hex'), byteSize: winner!.body.length }, retainUntil);
    }
  } };
}
