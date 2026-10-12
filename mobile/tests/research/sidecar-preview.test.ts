import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SourceRef } from '../../../packages/evidence-contracts/contracts.mjs';
import { assertResearchContentPath, sidecarPreviewSource, verifySidecarOriginal, verifySidecarPreview, SIDECAR_PREVIEW_MAX_BYTES } from '../../src/research/sidecar-preview-policy';
import type { ResearchSource } from '../../src/research/review-model';

const bytes = Buffer.from('P5\n2 2\n255\n\x00\x20\x40\x60', 'binary');
const hash = createHash('sha256').update(bytes).digest('hex');
const ref = { sourceId: 'rnd_source_rnd_sidecar_123', proofId: 'proof_1', objectVersionId: 'version_1', sha256: `sha256:${hash}`, byteLength: bytes.length, mimeType: 'image/x-portable-graymap', relationship: 'CONCURRENT_SIDECAR', retentionState: 'AVAILABLE' } as SourceRef;
const record = { evidenceId: 'rnd_sidecar_123', sha256: hash, byteLength: bytes.length, mimeType: ref.mimeType, relationship: ref.relationship, legId: 'OUTBOUND' } satisfies ResearchSource;
const source = sidecarPreviewSource(ref, record, 'proof_1');

test('native sidecar preview requires the observation and current authorized source to agree', () => {
  assert.equal(source.id, record.evidenceId); assert.equal(source.sha256, hash);
  for (const changed of [
    { ...ref, proofId: 'proof_other' }, { ...ref, sourceId: 'rnd_source_ev_original' },
    { ...ref, retentionState: 'DELETED' }, { ...ref, relationship: 'ORIGINAL_RECORDING' },
    { ...ref, sha256: 'a'.repeat(64) }, { ...ref, byteLength: bytes.length + 1 },
    { ...ref, byteLength: SIDECAR_PREVIEW_MAX_BYTES + 1 }, { ...ref, objectVersionId: '' },
  ]) assert.throws(() => sidecarPreviewSource(changed as SourceRef, record, 'proof_1'), /does not match/);
  assert.throws(() => sidecarPreviewSource(ref, undefined, 'proof_1'));
  assert.throws(() => sidecarPreviewSource(ref, { ...record, relationship: 'ORIGINAL_RECORDING' }, 'proof_1'));
  assert.throws(() => sidecarPreviewSource(ref, { ...record, objectVersionId: 'another_version' }, 'proof_1'));
});

test('original PGM verification rejects altered, truncated and substituted bytes', () => {
  verifySidecarOriginal(bytes, source);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  for (const value of [changed, bytes.subarray(0, -1), Buffer.from('not the original')]) assert.throws(() => verifySidecarOriginal(value, source), /committed length and hash/);
});

test('PNG display has explicit source and transformation binding, separate from original hash', () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const headers = { 'Content-Type': 'image/png', 'X-PackProof-Source-SHA256': hash, 'X-PackProof-Preview-Transformation': 'PGM_LUMA_TO_PNG_NO_RESIZE' };
  verifySidecarPreview(headers, png, source);
  assert.throws(() => verifySidecarOriginal(png, source));
  for (const changed of [{ ...headers, 'X-PackProof-Source-SHA256': 'b'.repeat(64) }, { ...headers, 'Content-Type': 'image/jpeg' }, { ...headers, 'X-PackProof-Preview-Transformation': '' }]) assert.throws(() => verifySidecarPreview(changed, png, source), /different source binding/);
  assert.throws(() => verifySidecarPreview(headers, bytes, source));
});

test('research content routes allow only bounded sidecar IDs and existing exports', () => {
  for (const path of ['/sidecars/rnd_sidecar_123', '/sidecars/rnd_sidecar_123/preview', '/analyses/analysis_1/artifacts/0', '/analyses/analysis_1/export.zip', '/export.zip']) assertResearchContentPath(path);
  for (const path of ['https://elsewhere.test/source', '//elsewhere.test', '/sidecars/../export.zip', '/sidecars/rnd_sidecar_1?token=x', '/sidecars/rnd_sidecar_1/preview/extra', '/sidecars/ev_original', '/sidecars/rnd_sidecar_%2f']) assert.throws(() => assertResearchContentPath(path));
});
