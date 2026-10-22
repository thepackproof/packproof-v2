/** Additive M2 profile. Never pass historical manifests through the JCS serializer. */
import { createHash, createPublicKey } from 'node:crypto';
import jcs from 'canonicalize';
import { base64url, flattenedVerify, importSPKI, type FlattenedJWS } from 'jose';
import { fromBER } from 'asn1js';
import { createECDSASignatureFromCMS } from 'pkijs';
import type { KmsSigningTransport } from './kms-signing-runtime.js';

export const ENVELOPE_PROFILE = 'packproof.integrity-envelope.v1' as const;
export const COVERAGE_PROFILE = 'packproof.integrity-coverage.v1' as const;
export const ENVELOPE_TYPE = 'application/packproof-integrity+jws' as const;
export type RecordType = 'CORE' | 'STAGE' | 'SUPPLEMENT';
export interface ExactObject { bucket: string; key: string; versionId: string; }
export interface CoverageArtifact {
  path: string; kind: 'MANIFEST' | 'ORIGINAL' | 'DERIVATIVE'; sha256: string; byteSize: number;
  required: boolean; storage: ExactObject; sourcePath: string | null;
}
export interface IntegrityCoverage {
  profile: typeof COVERAGE_PROFILE; proofId: string; recordType: RecordType; recordId: string;
  artifacts: CoverageArtifact[];
  stages: { stageId: string; manifestPath: string; manifestSha256: string }[];
  omissions: { path: string; reason: string }[];
}
export interface IntegrityEnvelope {
  profile: typeof ENVELOPE_PROFILE; proofId: string; recordType: RecordType; recordId: string;
  manifestSchema: string; manifestPath: string; manifestSha256: string;
  coverageSha256: string; issuer: string; issuedAt: string;
}
export interface EnvelopeJws { protected: string; payload: string; signature: string; }
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const requireThat = (ok: unknown, code: string): void => { if (!ok) throw new Error(code); };
const recordTypes = ['CORE', 'STAGE', 'SUPPLEMENT'];
const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_:/.-]{1,200}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const safePath = (v: unknown) => typeof v === 'string' && v.length <= 1024 && /^[A-Za-z0-9_./-]+$/.test(v) && v.split('/').every(p => p && p !== '.' && p !== '..');
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
function exact(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  requireThat(!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(','), 'INVALID_PROFILE_FIELDS');
}
export function jcsBytes(value: unknown): Buffer {
  const serialized = jcs(value);
  requireThat(typeof serialized === 'string', 'INVALID_JCS_VALUE');
  return Buffer.from(serialized!);
}
export function validateCoverage(value: unknown): asserts value is IntegrityCoverage {
  exact(value, ['profile', 'proofId', 'recordType', 'recordId', 'artifacts', 'stages', 'omissions']);
  requireThat(value.profile === COVERAGE_PROFILE && identifier(value.proofId) && identifier(value.recordId) && recordTypes.includes(value.recordType as string), 'INVALID_COVERAGE_IDENTITY');
  requireThat(Array.isArray(value.artifacts) && value.artifacts.length > 0 && value.artifacts.length <= 4000 && Array.isArray(value.stages) && value.stages.length <= 1000 && Array.isArray(value.omissions) && value.omissions.length <= 4000, 'INVALID_COVERAGE_SIZE');
  const artifacts = value.artifacts as unknown[];
  const paths = new Map<string, CoverageArtifact>();
  for (const item of artifacts) {
    exact(item, ['path', 'kind', 'sha256', 'byteSize', 'required', 'storage', 'sourcePath']);
    requireThat(safePath(item.path) && !paths.has(item.path as string) && !['package.json', 'integrity/envelope.jws.json', 'integrity/coverage.json'].includes(item.path as string), 'INVALID_ARTIFACT_PATH');
    requireThat(['MANIFEST', 'ORIGINAL', 'DERIVATIVE'].includes(item.kind as string) && digest(item.sha256) && Number.isSafeInteger(item.byteSize) && (item.byteSize as number) >= 0 && typeof item.required === 'boolean', 'INVALID_ARTIFACT');
    exact(item.storage, ['bucket', 'key', 'versionId']);
    requireThat(text(item.storage.bucket, 63) && text(item.storage.key, 1024) && text(item.storage.versionId, 1024) && item.storage.versionId !== 'null', 'EXACT_OBJECT_VERSION_REQUIRED');
    requireThat(item.kind === 'DERIVATIVE' ? safePath(item.sourcePath) : item.sourcePath === null, 'INVALID_SOURCE_RELATIONSHIP');
    paths.set(item.path as string, item as unknown as CoverageArtifact);
  }
  for (const item of paths.values()) if (item.kind === 'DERIVATIVE') requireThat(paths.get(item.sourcePath!)?.kind === 'ORIGINAL', 'ORIGINAL_SOURCE_REQUIRED');
  const stageIds = new Set<string>(), stagePaths = new Set<string>();
  for (const stage of value.stages as unknown[]) {
    exact(stage, ['stageId', 'manifestPath', 'manifestSha256']);
    const artifact = paths.get(stage.manifestPath as string);
    requireThat(identifier(stage.stageId) && !stageIds.has(stage.stageId as string) && !stagePaths.has(stage.manifestPath as string) && artifact?.kind === 'MANIFEST' && artifact.required && artifact.sha256 === stage.manifestSha256, 'INVALID_STAGE_COMMITMENT');
    stageIds.add(stage.stageId as string); stagePaths.add(stage.manifestPath as string);
  }
  const omitted = new Set<string>();
  for (const omission of value.omissions as unknown[]) {
    exact(omission, ['path', 'reason']);
    requireThat(safePath(omission.path) && !omitted.has(omission.path as string) && text(omission.reason, 500), 'INVALID_OMISSION');
    omitted.add(omission.path as string);
  }
}
export function validateEnvelope(value: unknown): asserts value is IntegrityEnvelope {
  exact(value, ['profile', 'proofId', 'recordType', 'recordId', 'manifestSchema', 'manifestPath', 'manifestSha256', 'coverageSha256', 'issuer', 'issuedAt']);
  requireThat(value.profile === ENVELOPE_PROFILE && identifier(value.proofId) && identifier(value.recordId) && identifier(value.manifestSchema) && recordTypes.includes(value.recordType as string) && safePath(value.manifestPath) && digest(value.manifestSha256) && digest(value.coverageSha256), 'INVALID_ENVELOPE');
  requireThat(typeof value.issuer === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(value.issuer) && value.issuer.length <= 300, 'INVALID_ISSUER');
  requireThat(typeof value.issuedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.issuedAt) && new Date(value.issuedAt).toISOString() === value.issuedAt, 'INVALID_ISSUED_AT');
}
/** The manifest is opaque bytes: use the recorded digest, never reserialize its JSON. */
export function prepareEnvelope(input: Omit<IntegrityEnvelope, 'profile' | 'coverageSha256'> & { manifestBytes: Uint8Array; coverage: IntegrityCoverage }) {
  validateCoverage(input.coverage);
  const { manifestBytes, coverage, ...identity } = input;
  const coverageBytes = jcsBytes(coverage);
  const envelope: IntegrityEnvelope = { ...identity, profile: ENVELOPE_PROFILE, coverageSha256: sha256(coverageBytes) };
  validateEnvelope(envelope);
  const manifest = coverage.artifacts.find(a => a.path === envelope.manifestPath);
  requireThat(coverage.proofId === envelope.proofId && coverage.recordId === envelope.recordId && coverage.recordType === envelope.recordType, 'COVERAGE_IDENTITY_MISMATCH');
  requireThat(sha256(manifestBytes) === envelope.manifestSha256 && manifest?.kind === 'MANIFEST' && manifest.required && manifest.sha256 === envelope.manifestSha256 && manifest.byteSize === manifestBytes.byteLength, 'FROZEN_MANIFEST_MISMATCH');
  return { envelope, envelopeBytes: jcsBytes(envelope), coverageBytes };
}
/** Isolated KMS adapter. Call only after durable job/preservation checks, outside DB transactions. */
export async function createEnvelopeSigner(input: { keyArn: string; keyId: string; pinnedPublicKeyPem: string; transport: KmsSigningTransport }) {
  requireThat(/^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$/.test(input.keyArn) && identifier(input.keyId), 'EXACT_KMS_KEY_REQUIRED');
  const key = createPublicKey(input.pinnedPublicKeyPem);
  requireThat(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'P256_PUBLIC_KEY_REQUIRED');
  const publicBytes = key.export({ format: 'der', type: 'spki' });
  const remote = await input.transport.getPublicKey({ KeyId: input.keyArn });
  requireThat(remote.KeyId === input.keyArn && remote.KeySpec === 'ECC_NIST_P256' && remote.KeyUsage === 'SIGN_VERIFY' && remote.SigningAlgorithms?.includes('ECDSA_SHA_256') && remote.PublicKey && Buffer.from(remote.PublicKey).equals(publicBytes), 'KMS_PUBLIC_KEY_MISMATCH');
  const joseKey = await importSPKI(input.pinnedPublicKeyPem, 'ES256');
  return async (envelopeBytes: Uint8Array): Promise<EnvelopeJws> => {
    requireThat(envelopeBytes.byteLength > 0 && envelopeBytes.byteLength <= 16384, 'ENVELOPE_SIZE_LIMIT');
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelopeBytes));
    validateEnvelope(envelope);
    requireThat(jcsBytes(envelope).equals(Buffer.from(envelopeBytes)), 'NONCANONICAL_ENVELOPE');
    const protectedHeader = base64url.encode(jcsBytes({ alg: 'ES256', kid: input.keyId, typ: ENVELOPE_TYPE }));
    const payload = base64url.encode(envelopeBytes);
    const signingInput = Buffer.from(`${protectedHeader}.${payload}`, 'ascii');
    const response = await input.transport.sign({ KeyId: input.keyArn, SigningAlgorithm: 'ECDSA_SHA_256', MessageType: 'DIGEST', Message: createHash('sha256').update(signingInput).digest() });
    requireThat(response.KeyId === input.keyArn && response.SigningAlgorithm === 'ECDSA_SHA_256' && response.Signature && response.Signature.byteLength <= 80, 'INVALID_KMS_SIGNATURE_RESPONSE');
    const der = Buffer.from(response.Signature!);
    const parsed = fromBER(der);
    requireThat(parsed.offset === der.byteLength, 'INVALID_DER_SIGNATURE');
    const signature = new Uint8Array(createECDSASignatureFromCMS(parsed.result, 32));
    requireThat(signature.byteLength === 64, 'INVALID_ES256_SIGNATURE_WIDTH');
    const jws: EnvelopeJws = { protected: protectedHeader, payload, signature: base64url.encode(signature) };
    // Vetted JOSE verification independently catches wrong keys, double hashing and malformed conversion.
    const checked = await flattenedVerify(jws as FlattenedJWS, joseKey, { algorithms: ['ES256'] });
    requireThat(Buffer.from(checked.payload).equals(Buffer.from(envelopeBytes)), 'SIGNED_PAYLOAD_MISMATCH');
    return jws;
  };
}
