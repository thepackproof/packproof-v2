export const RECEIPT_CONSENT_VERSION = 'packproof.research-consent.v1';
export interface ResearchCapabilities {
  enabled: boolean; killSwitch: boolean; profile?: string; qualification?: string;
  supportedOperations?: { captureReceipts?: boolean; receiptReview?: boolean; receiptExport?: boolean; receiptExportMode?: string };
  features: Record<string, { collection: boolean; internalDisplay?: boolean }>;
}
export interface ReceiptConsents {
  proofId: string;
  consents: Array<{ purpose: string; version: string; granted: boolean; recordedAt: string | null }>;
  allowedPurposes: string[];
}
export function productionReceiptsAvailable(policy: ResearchCapabilities): boolean {
  return policy.enabled === true && policy.killSwitch === false && policy.profile === 'capture-receipts-v1' &&
    policy.qualification === 'DIGITAL_RECEIPTS_ONLY' && policy.supportedOperations?.captureReceipts === true &&
    policy.features.verifiedcapture?.collection === true;
}
export function receiptConsentGranted(consent: ReceiptConsents, proofId: string): boolean {
  if (consent.proofId !== proofId) throw new Error('Capture receipt preferences belong to a different Proof.');
  return consent.consents.some(item => item.purpose === 'EXPERIMENTAL_ANALYSIS' && item.version === RECEIPT_CONSENT_VERSION && item.granted === true);
}
export async function productionReceiptEnrollment(client: {
  researchCapabilities(): Promise<ResearchCapabilities>;
  researchRequest<T>(proofId: string, path: string): Promise<T>;
}, proofId: string): Promise<boolean> {
  const policy = await client.researchCapabilities();
  if (!productionReceiptsAvailable(policy)) return false;
  const consent = await client.researchRequest<ReceiptConsents>(proofId, '/consents');
  return receiptConsentGranted(consent, proofId) && consent.allowedPurposes.includes('EXPERIMENTAL_ANALYSIS');
}
export function researchCaptureNotice(bound: boolean, preauthorized: boolean): string {
  if (preauthorized) return 'This order already has a camera authorization. An optional capture receipt cannot be added to this take. Your ordinary recording is still preserved.';
  return bound ? 'Optional capture receipt enabled for this take. It describes the final file and session binding, not the scene or uninterrupted capture.'
    : 'No optional capture receipt is attached to this take. It may be turned off or unavailable. Your ordinary recording is still preserved.';
}
export function assertProductionReceiptOperation(path: string, method: string): void {
  const allowed = method === 'GET' && ['/consents', '/capture-receipts'].includes(path) ||
    method === 'POST' && (['/consents', '/capture-intents', '/exports'].includes(path) || /^\/capture-intents\/[a-zA-Z0-9_-]+\/(?:start|close)$/.test(path));
  if (!allowed) throw new Error('This operation is unavailable in the production capture receipt profile.');
}
