import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
export interface ReceiptReview {
  proofId: string; qualification: 'DIGITAL_RECEIPTS_ONLY'; limitations: string[];
  captureReceipts: Array<{ canonicalJson: string; digest: string; signature: unknown; receipt: {
    schemaVersion: 'packproof.capture-receipt.v1'; proofId: string; intentId: string; captureSessionId: string; receivedAt: string;
    sources: Array<{ evidenceId: string; sha256: string; byteLength: number; mimeType: string }>;
    assurance: { chainCoverage: 'FINAL_FILE_ONLY'; signatureVerification?: string; sensorAttestation?: string };
  } }>;
}
/** Detect malformed/cross-Proof responses; this is byte integrity, not independent signature verification. */
export function checkedReceiptReview(review: ReceiptReview, proofId: string): ReceiptReview {
  if (review.proofId !== proofId || review.qualification !== 'DIGITAL_RECEIPTS_ONLY' || !Array.isArray(review.captureReceipts) || review.captureReceipts.length > 500)
    throw new Error('Capture receipts do not match this Proof.');
  for (const row of review.captureReceipts) {
    const receipt = row.receipt;
    if (receipt.schemaVersion !== 'packproof.capture-receipt.v1' || receipt.proofId !== proofId || receipt.assurance.chainCoverage !== 'FINAL_FILE_ONLY' ||
        !Array.isArray(receipt.sources) || !receipt.sources.length || receipt.sources.some(source => !source.evidenceId || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1) ||
        canonicalize(receipt) !== row.canonicalJson || bytesToHex(sha256(new TextEncoder().encode(row.canonicalJson))) !== row.digest.replace(/^sha256:/, ''))
      throw new Error('Capture receipt content or source binding is invalid.');
  }
  return review;
}
export function assertClosedReceipt(row: ReceiptReview['captureReceipts'][number], expected: { proofId: string; intentId: string; captureSessionId: string; evidenceId: string; clientCanonicalJson: string }): void {
  checkedReceiptReview({ proofId: expected.proofId, qualification: 'DIGITAL_RECEIPTS_ONLY', captureReceipts: [row], limitations: [] }, expected.proofId);
  const inventory = JSON.parse(expected.clientCanonicalJson);
  if (row.receipt.intentId !== expected.intentId || row.receipt.captureSessionId !== expected.captureSessionId || row.receipt.sources.length !== 1 ||
      row.receipt.sources[0].evidenceId !== expected.evidenceId || row.receipt.sources[0].sha256 !== inventory.mediaSha256 || row.receipt.sources[0].byteLength !== inventory.mediaByteLength)
    throw new Error('Received capture receipt does not match this saved recording.');
}
