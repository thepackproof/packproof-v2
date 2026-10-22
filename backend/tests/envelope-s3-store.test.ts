import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createEnvelopeS3Store, type EnvelopeS3Transport } from '../src/integrity/envelope-s3-store.js';
import { sha256 } from '../src/integrity/envelope-profile.js';

const now = new Date('2026-10-22T05:00:00.000Z'), until = '2027-10-22T05:00:00.000Z';
const body = Buffer.from('original bytes'), key = `integrity/v1/manifests/${sha256(body)}.json`;
function fixture() {
  const calls: { operation: string; input: any }[] = [];
  const value = { body, versionId: 'exact-version-1', mode: 'COMPLIANCE', until: new Date(until), putStatus: 0, getVersion: 'exact-version-1' };
  const transport: EnvelopeS3Transport = {
    head: async input => { calls.push({ operation: 'head', input }); return { $metadata: {}, VersionId: value.versionId, ContentLength: value.body.length }; },
    get: async input => { calls.push({ operation: 'get', input }); return { $metadata: {}, VersionId: value.getVersion, ContentLength: value.body.length, Body: Readable.from([value.body]) as any }; },
    put: async input => { calls.push({ operation: 'put', input }); if (value.putStatus) throw { $metadata: { httpStatusCode: value.putStatus } }; value.body = Buffer.from(input.Body as Uint8Array); return { $metadata: {}, VersionId: value.versionId }; },
    retention: async input => { calls.push({ operation: 'retention', input }); return { $metadata: {}, Retention: { Mode: value.mode as 'COMPLIANCE', RetainUntilDate: value.until } }; },
  };
  const store = createEnvelopeS3Store({ artifactBucket: 'artifacts', evidenceBuckets: ['originals'], expectedBucketOwner: '123456789012', clock: { now: () => now }, transport });
  const artifact = { storage: { bucket: 'originals', key: 'committed/media', versionId: value.versionId }, sha256: sha256(body), byteSize: body.length };
  return { calls, value, store, artifact };
}
describe('exact-version protected envelope storage adapter', () => {
  it('checks original bytes and actual compliance retention on the exact version without a latest lookup', async () => {
    const f = fixture(); expect(await f.store.verify(f.artifact, until)).toMatchObject({ object: f.artifact.storage, mode: 'COMPLIANCE', sha256: f.artifact.sha256 });
    expect(f.calls.map(c => c.operation)).toEqual(['get', 'retention']);
    for (const call of f.calls) expect(call.input).toMatchObject({ VersionId: 'exact-version-1', ExpectedBucketOwner: '123456789012' });
  });
  it('conditionally creates an explicitly locked artifact with a verified upload checksum and reads the returned version', async () => {
    const f = fixture(); await f.store.preserve('artifacts', key, body, until);
    expect(f.calls[0]).toMatchObject({ operation: 'put', input: { IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: Buffer.from(sha256(body), 'hex').toString('base64'), ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(until), ExpectedBucketOwner: '123456789012' } });
    expect(f.calls[1]).toMatchObject({ operation: 'get', input: { VersionId: 'exact-version-1' } });
  });
  it.each(['GOVERNANCE', 'missing'])('refuses %s as compliance protection', async mode => {
    const f = fixture(); f.value.mode = mode;
    await expect(f.store.verify(f.artifact, until)).rejects.toThrow('ENVELOPE_PROTECTION_MISMATCH');
  });
  it('refuses short retention, modified bytes and a substituted version', async () => {
    const f = fixture(); f.value.until = now;
    await expect(f.store.verify(f.artifact, until)).rejects.toThrow('ENVELOPE_PROTECTION_MISMATCH');
    f.value.until = new Date(until); f.value.body = Buffer.from('modified bytes');
    await expect(f.store.verify(f.artifact, until)).rejects.toThrow(/ENVELOPE_OBJECT_(SIZE|DIGEST)_MISMATCH/);
    f.value.body = body; f.value.getVersion = 'latest-substitute';
    await expect(f.store.verify(f.artifact, until)).rejects.toThrow('ENVELOPE_OBJECT_METADATA_MISMATCH');
  });
  it('reads the existing conditional-write winner and treats a 409 as unresolved', async () => {
    const f = fixture(); f.value.putStatus = 412;
    const receipt = await f.store.preserve('artifacts', key, Buffer.from('different contender'), until);
    expect(receipt.sha256).toBe(sha256(body)); expect(f.calls.map(c => c.operation)).toEqual(['put', 'head', 'get', 'get', 'retention']);
    f.value.putStatus = 409; await expect(f.store.preserve('artifacts', key, body, until)).rejects.toMatchObject({ $metadata: { httpStatusCode: 409 } });
  });
  it('cannot write originals, inspect latest media, or substitute an unconfigured bucket', async () => {
    const f = fixture();
    await expect(f.store.preserve('originals', 'committed/media', body, until)).rejects.toThrow('ENVELOPE_ARTIFACT_SCOPE');
    await expect(f.store.find('originals', 'committed/media', 100)).rejects.toThrow('ENVELOPE_ARTIFACT_SCOPE');
    await expect(f.store.verify({ ...f.artifact, storage: { ...f.artifact.storage, bucket: 'unconfigured' } }, until)).rejects.toThrow('ENVELOPE_EXACT_VERSION_REQUIRED');
    await expect(f.store.verify({ ...f.artifact, storage: { ...f.artifact.storage, versionId: 'null' } }, until)).rejects.toThrow('ENVELOPE_EXACT_VERSION_REQUIRED');
    expect(f.calls).toHaveLength(0);
  });
});
