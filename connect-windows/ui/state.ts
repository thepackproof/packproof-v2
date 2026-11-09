import type { Configuration, ConnectStatus } from './types';
/** Internal checkpoints are retained for safe resume. Operators only see three stages. */
export const STEPS = ['Welcome', 'Computer check', 'Workspace', 'Export source', 'Field mapping', 'First import', 'Automatic collection'] as const;
export const GUIDED_STAGES = ['Find records', 'Get ready', 'Start collecting'] as const;
export function guidedStage(step: number): 0 | 1 | 2 {
  if (step <= 3) return 0;
  if (step === 4) return 1;
  return 2;
}
const synonyms: Record<string, string[]> = {
  shipmentReference: ['shipment reference', 'shipment_ref', 'shipment id', 'shipment identifier', 'shipment number', 'shipment no', 'order id', 'order number'],
  itemTitle: ['item description', 'description', 'item title', 'item_title'],
  quantity: ['quantity', 'qty'], trackingNumber: ['tracking number', 'tracking_number'],
  carrier: ['carrier'], shippedAt: ['shipment date', 'shipment_date'], locationId: ['location id', 'location_id'],
};
export function suggestMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const [field, names] of Object.entries(synonyms)) {
    const normalized = (value: string) => value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    const matches = headers.filter(header => names.some(name => normalized(name) === normalized(header)));
    if (matches.length === 1) mapping[field] = matches[0];
  }
  return mapping;
}
export function configKey(config: Configuration | undefined): string { const source=config?.sourceContract; return config ? JSON.stringify([config.folderDigest, config.sourceName, config.integrationAccountId, config.operatorMembershipId, config.locationId, config.timeZone, config.importValidRows, config.offlineWindowHours, source ? [source.schema,source.exporterName,source.exporterVersion,source.expectedHeaders,source.expectedIntervalSeconds,source.backfillFrom] : null, Object.entries(config.mapping).sort(([a], [b]) => a.localeCompare(b))]) : ''; }
export function previewValid(status: ConnectStatus): boolean {
  const counts = status.preview?.counts;
  return !!counts && (counts.valid > 0) && !counts.duplicate && !counts.invalid && !counts.ambiguous && !counts.failed;
}
export function verificationCurrent(status: ConnectStatus, draft: Configuration | undefined, dirty: boolean): boolean {
  return status.state !== 'revoked' && !dirty && !status.pendingProposal && !!status.verification?.complete && !!status.verification.recordId && configKey(draft) === configKey(status.config)
    && typeof status.configRevision === 'number' && status.verification.configRevision === status.configRevision
    && !!status.source?.fileSha256 && status.verification.fileSha256 === status.source.fileSha256;
}
export function resumeStep(status: ConnectStatus): number {
  if (['active', 'paused'].includes(status.state)) return 6;
  if (status.preview) return 5;
  if (status.source?.accessible) return status.source.headers?.length ? 4 : 3;
  if (status.installationId) return 3;
  if (status.enrollment) return 2;
  return 0;
}
