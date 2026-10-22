import {recipientStorageFixture} from './recipient-storage-fixture.js';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EnvelopeS3Transport } from '../src/integrity/envelope-s3-store.js';
import { createRecipientS3Store } from '../src/export/recipient-s3-store.js';
import { RECIPIENT_PROTECTION_PROFILE, recipientArtifactKey, type RecipientProtection } from '../src/export/recipient-preservation.js';

const clock = { now: () => new Date('2026-10-22T08:00:00.000Z') };
const policy: RecipientProtection = { profile: RECIPIENT_PROTECTION_PROFILE, bucket: 'protected-recipient-fixture', retainUntil: '2027-10-22T08:00:00.000Z' };
describe('protected recipient artifact storage', () => {
  it('conditionally publishes content-addressed files and reads only their exact protected version', async () => {
    const f = recipientStorageFixture(clock,policy), bytes = Buffer.from('synthetic file bytes');
    const receipt = await f.store.preserveFile('rex_example', bytes, 'application/pdf', policy);
    expect(receipt.object.versionId).toBe('version-1'); expect(receipt.mode).toBe('COMPLIANCE');
    expect((await f.store.preserveFile('rex_example', bytes, 'application/pdf', policy)).object).toEqual(receipt.object);
    f.calls.length = 0;
    expect(await f.store.read('rex_example', receipt, policy)).toEqual(bytes);
    expect(f.calls.map(c => c.operation)).toEqual(['get', 'retention']);
    for (const call of f.calls) expect(call.input).toMatchObject({ Bucket: policy.bucket, ExpectedBucketOwner: '123456789012', VersionId: 'version-1' });
  });
  it('recovers a lost artifact publication response and retains the first conditional winner', async () => {
    const f = recipientStorageFixture(clock,policy), first = Buffer.from('{"first":"accepted request binding"}');
    f.loseResponse(); await expect(f.store.preserveArtifact('rex_retry', first, policy)).rejects.toThrow('Response lost');
    const recovered = await f.store.findArtifact('rex_retry', policy);
    expect(recovered?.bytes).toEqual(first); expect(recovered?.receipt.object.key).toBe(recipientArtifactKey('rex_retry'));
    const contender = await f.store.preserveArtifact('rex_retry', Buffer.from('{"later":"contender"}'), policy);
    expect(contender.bytes).toEqual(first); expect(f.objects.size).toBe(1);
    for (const put of f.calls.filter(c => c.operation === 'put')) {
      expect(put.input.IfNoneMatch).toBe('*'); expect(put.input).not.toHaveProperty('ObjectLockRetainUntilDate');
      expect(put.input.ChecksumAlgorithm).toBe('SHA256');
    }
  });
  it('fails closed on wrong versions, corrupted bytes, weak locks and shortened retention', async () => {
    const f = recipientStorageFixture(clock,policy), receipt = await f.store.preserveFile('rex_guard', Buffer.from('preserved'), 'image/png', policy);
    f.setVersion('substituted'); await expect(f.store.read('rex_guard', receipt, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' }); f.setVersion('version-1');
    f.setMode('GOVERNANCE'); await expect(f.store.read('rex_guard', receipt, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' }); f.setMode('COMPLIANCE');
    f.setRetention('2026-11-22T08:00:00.000Z'); await expect(f.store.read('rex_guard', receipt, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' }); f.setRetention(policy.retainUntil);
    f.objects.get(receipt.object.key)!.bytes = Buffer.from('different');
    await expect(f.store.read('rex_guard', receipt, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' });
  });
  it('rejects crossed jobs/buckets, unsafe identifiers and unbounded writes before storage', async () => {
    const f = recipientStorageFixture(clock,policy), receipt = await f.store.preserveFile('rex_one', Buffer.from('one'), 'image/png', policy); f.calls.length = 0;
    await expect(f.store.read('rex_two', receipt, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' });
    await expect(f.store.read('rex_one', { ...receipt, object: { ...receipt.object, bucket: 'another-bucket' } }, policy)).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_MISMATCH' });
    await expect(f.store.preserveFile('rex_../../other', Buffer.from('one'), 'image/png', policy)).rejects.toThrow();
    await expect(f.store.preserveFile('rex_one', Buffer.alloc(12 * 1024 * 1024 + 1), 'image/png', policy)).rejects.toThrow();
    await expect(f.store.preserveFile('rex_one', Buffer.from('one'), 'text/html', policy)).rejects.toThrow();
    await expect(f.store.findArtifact('rex_one', { ...policy, retainUntil: clock.now().toISOString() })).rejects.toMatchObject({ code: 'EXPORT_PROTECTION_UNAVAILABLE' });
    expect(f.calls).toHaveLength(0);
  });
});
