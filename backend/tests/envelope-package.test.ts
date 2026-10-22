import { generateKeyPairSync } from 'node:crypto';
import { FlattenedSign } from 'jose';
import { describe, expect, it } from 'vitest';
import { COVERAGE_PROFILE, ENVELOPE_TYPE, prepareEnvelope, sha256, type IntegrityCoverage } from '../src/integrity/envelope-profile.js';
import { streamEnvelopePackage } from '../src/integrity/envelope-package.js';
import { collectSmallZip } from '../src/export/zip-stream.js';

async function fixture() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const manifest = Buffer.from('{"immutable":true}');
  const coverage: IntegrityCoverage = { profile: COVERAGE_PROFILE, proofId: 'proof_a', recordType: 'CORE', recordId: 'manifest_a',
    artifacts: [{ path: 'manifest.json', kind: 'MANIFEST', sha256: sha256(manifest), byteSize: manifest.length, required: true, storage: { bucket: 'fixture', key: 'original', versionId: 'original-v1' }, sourcePath: null }], stages: [], omissions: [] };
  const prepared = prepareEnvelope({ proofId: 'proof_a', recordType: 'CORE', recordId: 'manifest_a', manifestSchema: 'manifest.v1', manifestPath: 'manifest.json', manifestSha256: sha256(manifest), issuer: 'https://packproof-m1.test', issuedAt: '2026-10-22T04:00:00.000Z', manifestBytes: manifest, coverage });
  const jws = await new FlattenedSign(prepared.envelopeBytes).setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: ENVELOPE_TYPE }).sign(pair.privateKey);
  return { jws: { protected: jws.protected!, payload: jws.payload as string, signature: jws.signature }, coverage, trustedKeyId: 'test-key', trustedPublicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    openExactObject: async (object: { versionId: string }) => ({ versionId: object.versionId, body: (async function* () { yield manifest; })() }), assertCurrentAccess: async () => {} };
}
describe('version-bound additive package streaming', () => {
  it('exports a complete archive from the exact object version', async () => {
    const input = await fixture(); const requested: unknown[] = [];
    const open = input.openExactObject; input.openExactObject = async object => { requested.push(object); return open(object); };
    const archive = await collectSmallZip(await streamEnvelopePackage(input));
    expect(requested).toEqual([{ bucket: 'fixture', key: 'original', versionId: 'original-v1' }]);
    expect(archive.subarray(-22).readUInt32LE()).toBe(0x06054b50);
    expect(archive.includes(Buffer.from('{"immutable":true}'))).toBe(true);
  });
  it('rejects a latest-version fallback even if the bytes would match', async () => {
    const input = await fixture(); const open = input.openExactObject;
    input.openExactObject = async object => ({ ...await open(object), versionId: 'different-version' });
    await expect(collectSmallZip(await streamEnvelopePackage(input))).rejects.toThrow('EXACT_OBJECT_VERSION_MISMATCH');
  });
  it('cannot finish an archive after a storage digest mismatch', async () => {
    const input = await fixture();
    input.openExactObject = async object => ({ versionId: object.versionId, body: (async function* () { yield Buffer.from('changed'); })() });
    await expect(collectSmallZip(await streamEnvelopePackage(input))).rejects.toThrow('Source does not match');
  });
  it('reauthorizes during the stream and aborts before a successful directory', async () => {
    const input = await fixture(); let checks = 0;
    input.assertCurrentAccess = async () => { if (++checks > 5) throw Error('GRANT_REVOKED'); };
    await expect(collectSmallZip(await streamEnvelopePackage(input))).rejects.toThrow('GRANT_REVOKED');
    expect(checks).toBe(6);
  });
  it('does not create new signatures or accept substituted coverage', async () => {
    const input = await fixture(); input.coverage.proofId = 'wrong-proof';
    await expect(streamEnvelopePackage(input)).rejects.toThrow('SIGNED_COVERAGE_MISMATCH');
  });
});
