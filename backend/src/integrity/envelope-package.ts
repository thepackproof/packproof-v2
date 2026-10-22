/** Complete received-scope export. No signing, DB writes or latest-version reads. */
import { base64url, flattenedVerify, importSPKI } from 'jose';
import { streamZip, type ZipStreamEntry } from '../export/zip-stream.js';
import { ENVELOPE_TYPE, jcsBytes, sha256, validateCoverage, validateEnvelope, type EnvelopeJws, type ExactObject, type IntegrityCoverage } from './envelope-profile.js';

export async function streamEnvelopePackage(input: {
  jws: EnvelopeJws; coverage: IntegrityCoverage; trustedKeyId: string; trustedPublicKeyPem: string;
  openExactObject: (object: ExactObject) => Promise<{ versionId: string; body: AsyncIterable<Uint8Array> }>;
  assertCurrentAccess: () => Promise<void>;
}) {
  await input.assertCurrentAccess();
  validateCoverage(input.coverage);
  if (Object.keys(input.jws).sort().join(',') !== 'payload,protected,signature') throw Error('INVALID_JWS_FIELDS');
  const verified = await flattenedVerify(input.jws, await importSPKI(input.trustedPublicKeyPem, 'ES256'), { algorithms: ['ES256'] });
  const header = verified.protectedHeader;
  if (!header || Object.keys(header).sort().join(',') !== 'alg,kid,typ' || header.kid !== input.trustedKeyId || header.typ !== ENVELOPE_TYPE || base64url.encode(jcsBytes(header)) !== input.jws.protected) throw Error('INVALID_JWS_HEADER');
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload));
  validateEnvelope(envelope);
  const coverageBytes = jcsBytes(input.coverage);
  const manifest = input.coverage.artifacts.find(a => a.path === envelope.manifestPath);
  if (!Buffer.from(verified.payload).equals(jcsBytes(envelope)) || input.coverage.proofId !== envelope.proofId || input.coverage.recordId !== envelope.recordId || input.coverage.recordType !== envelope.recordType || sha256(coverageBytes) !== envelope.coverageSha256 || manifest?.kind !== 'MANIFEST' || !manifest.required || manifest.sha256 !== envelope.manifestSha256) throw Error('SIGNED_COVERAGE_MISMATCH');
  if (input.coverage.omissions.length) throw Error('COMPLETE_EXPORT_REQUIRES_ALL_ARTIFACTS');
  const metadata = jcsBytes({ schema: 'packproof.signed-proof-package.v2', proofId: envelope.proofId, envelopePath: 'integrity/envelope.jws.json', coveragePath: 'integrity/coverage.json', timestamp: { state: 'NOT_PRESENT' } });
  async function* entries(): AsyncIterable<ZipStreamEntry> {
    for (const [name, bytes] of [['package.json', metadata], ['integrity/envelope.jws.json', jcsBytes(input.jws)], ['integrity/coverage.json', coverageBytes]] as const) {
      yield { name, body: (async function* () { yield bytes; })(), byteSize: bytes.length, sha256: sha256(bytes) };
    }
    for (const artifact of input.coverage.artifacts) {
      await input.assertCurrentAccess();
      const source = await input.openExactObject({ ...artifact.storage });
      if (source.versionId !== artifact.storage.versionId) throw Error('EXACT_OBJECT_VERSION_MISMATCH');
      yield { name: artifact.path, body: source.body, byteSize: artifact.byteSize, sha256: artifact.sha256 };
    }
  }
  // A failed hash, wrong object version or revoked authority prevents a complete ZIP directory.
  return streamZip(entries(), { beforeChunk: input.assertCurrentAccess });
}
