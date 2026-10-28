import type { ProofSearchItem, ProofSearchState } from '../../../packages/evidence-contracts/api-dashboard';

export const DASHBOARD_STATES: ReadonlyArray<{ value: ProofSearchState; label: string; description: string; icon: string }> = [
  { value: 'NEEDS_ATTENTION', label: 'Needs attention', description: 'Open the record to resolve its next step.', icon: 'shield' },
  { value: 'AWAITING_CAPTURE', label: 'Awaiting capture', description: 'Ready for someone to record the shipment.', icon: 'film' },
  { value: 'IN_PROGRESS', label: 'In progress', description: 'Recording, confirmation or preservation is underway.', icon: 'box' },
  { value: 'READY', label: 'Ready', description: 'Finalized with required preservation confirmed.', icon: 'check' },
];
export const dashboardStateLabel = (state: ProofSearchState) => DASHBOARD_STATES.find(item => item.value === state)?.label ?? state;
export function dashboardReason(row: ProofSearchItem): string {
  const reasons: Record<string, string> = {
    PRESERVATION_FAILED: 'PackProof is investigating preservation.',
    LEGACY_UNCONFIRMED: 'Preservation has not been confirmed for this older record.',
    FINALIZATION_INCOMPLETE: 'PackProof needs to review this record.',
    PRESERVATION_PENDING: 'Preservation is in progress.',
    CONFIRMATION_REQUIRED: 'Review and confirm the recording.',
    CAPTURE_REQUIRED: 'Record the shipment.',
  };
  return row.readiness.reason ? reasons[row.readiness.reason] ?? 'Open this record for details.' : 'Preservation confirmed.';
}
export function dashboardAction(row: ProofSearchItem): string {
  if (row.readiness.state === 'READY') return 'View Proof';
  if (row.readiness.reason === 'CONFIRMATION_REQUIRED') return 'Review recording';
  if (row.readiness.state === 'AWAITING_CAPTURE') return 'Open shipment';
  if (row.readiness.state === 'NEEDS_ATTENTION') return 'Review Proof';
  return 'Check progress';
}
export function dashboardTime(value: string | null): string {
  if (!value) return 'Not yet received';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}
/** Export only loaded search summaries, with spreadsheet formulas escaped. */
function cell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}
export function dashboardCsv(rows: ProofSearchItem[]): string {
  const header = ['Proof ID', 'Order reference', 'Item', 'Line items', 'Tracking', 'Provider', 'Status', 'Next step', 'Recorded by', 'Server received (UTC)', 'Created (UTC)', 'Updated (UTC)'];
  return '\uFEFF' + [header, ...rows.map(row => [row.proofId, row.externalId, row.itemTitle, row.itemCount, row.trackingNumber, row.provider,
    dashboardStateLabel(row.readiness.state), dashboardReason(row), row.recordedBy, row.serverReceivedAt, row.createdAt, row.updatedAt])].map(values => values.map(cell).join(',')).join('\r\n') + '\r\n';
}
