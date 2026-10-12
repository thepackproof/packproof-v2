import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { SourceRef } from '../../../packages/evidence-contracts/contracts.mjs';
import type { ResearchSource } from './review-model';

export const SIDECAR_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
export interface SidecarPreviewSource { id: string; sha256: string; byteLength: number; objectVersionId: string; }
const bareHash = (value: string) => value.replace(/^sha256:/, '');

export function sidecarPreviewSource(ref: SourceRef, record: ResearchSource | undefined, proofId: string): SidecarPreviewSource {
  const id = ref.sourceId.replace(/^rnd_source_/, '');
  if (!/^rnd_sidecar_[A-Za-z0-9_-]+$/.test(id) || ref.proofId !== proofId ||
    ref.relationship !== 'CONCURRENT_SIDECAR' || ref.retentionState !== 'AVAILABLE' ||
    ref.mimeType !== 'image/x-portable-graymap' || !record || record.evidenceId !== id ||
    record.relationship !== ref.relationship || record.mimeType !== ref.mimeType ||
    (record.objectVersionId !== undefined && record.objectVersionId !== ref.objectVersionId) ||
    bareHash(record.sha256) !== bareHash(ref.sha256) || record.byteLength !== ref.byteLength ||
    !/^[a-f0-9]{64}$/.test(bareHash(ref.sha256)) || !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength < 1 || ref.byteLength > SIDECAR_PREVIEW_MAX_BYTES || !ref.objectVersionId) {
    throw new Error('Native sidecar is unavailable or does not match this observation. Refresh the record.');
  }
  return { id, sha256: bareHash(ref.sha256), byteLength: ref.byteLength, objectVersionId: ref.objectVersionId };
}

export function assertResearchContentPath(path: string): void {
  if (!/^\/(?:analyses\/[a-zA-Z0-9_-]+\/(?:artifacts\/[0-9]+|export\.zip)|sidecars\/rnd_sidecar_[a-zA-Z0-9_-]+(?:\/preview)?|export\.zip)$/.test(path)) {
    throw new Error('Invalid research content path');
  }
}

export function verifySidecarOriginal(bytes: Uint8Array, source: SidecarPreviewSource): void {
  if (bytes.length !== source.byteLength || bytes.length > SIDECAR_PREVIEW_MAX_BYTES || bytesToHex(sha256(bytes)) !== source.sha256) {
    throw new Error('Native sidecar bytes do not match their committed length and hash');
  }
}

export function verifySidecarPreview(headers: Record<string, string>, bytes: Uint8Array, source: SidecarPreviewSource): void {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (normalized['x-packproof-source-sha256'] !== source.sha256 ||
    normalized['x-packproof-preview-transformation'] !== 'PGM_LUMA_TO_PNG_NO_RESIZE' ||
    normalized['content-type']?.split(';')[0].trim() !== 'image/png' || bytes.length > SIDECAR_PREVIEW_MAX_BYTES ||
    bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('Native sidecar display is unavailable or has a different source binding');
  }
}
