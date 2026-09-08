export interface IntakeItem { title: string | null; description?: string | null; quantity: number | null; variant?: string | null; }
export interface IntakeSnapshot { id: string; version: number; digest: string; proofId: string; transactionId: string; items: IntakeItem[]; store: string; orderReference: string; sourceKind: string; }
export interface IntakeOrder { observationId: string; readiness: 'RECEIVED' | 'NEEDS_INFORMATION' | 'READY' | 'QUARANTINED' | 'ARCHIVED'; reasons: string[]; transactionId: string | null; proofId: string | null; snapshot: IntakeSnapshot | null; }
export interface CaptureSessionGrant { id: string; proofId: string; policyVersion: string; state: string; expiresAt: string; recoverUntil: string; }
export interface IntakeAcceptance { session: CaptureSessionGrant; proofId: string; transactionId: string; orderSnapshot: IntakeSnapshot; }
export interface IntakeDevice { id: string; name: string; state: string; expiresAt?: string; }
export interface IntakeDeviceCredentials { deviceId: string; deviceToken: string; pairingCode?: string; }
export interface IntakeHandoff { id: string; snapshotId: string; sequence: number; expiresAt: string; state: string; orderSnapshot: IntakeSnapshot; }
export interface IntakePending { device: IntakeDevice; handoffs: IntakeHandoff[]; activeCapture?: (IntakeAcceptance & { handoff: IntakeHandoff }) | null; }
export interface IntakeCapabilities { enabled: boolean; handoffEnabled: boolean; emailEnabled: boolean; browserEnabled: boolean; shippoEnabled: boolean; mailDomainConfigured: boolean; }

export function intakeItemLabel(item: IntakeItem): string {
  return [item.title || item.description || 'Item description missing', item.variant, item.quantity == null ? 'Quantity missing' : `Quantity ${item.quantity}`].filter(Boolean).join(' · ');
}

/** A claimed authorization may only enter its original proof; never substitute context. */
export function assertIntakeAcceptance(value: IntakeAcceptance): void {
  if (!value.session?.id || value.session.proofId !== value.proofId || value.orderSnapshot?.proofId !== value.proofId || value.orderSnapshot.transactionId !== value.transactionId || !value.orderSnapshot.id)
    throw new Error('This order could not be matched safely. Refresh the order and try again.');
}

export function canPollHandoffs(input: { foreground: boolean; readyScreen: boolean; busy: boolean; paired: boolean; lastActivityAt: number; now: number }): boolean {
  return input.foreground && input.readyScreen && !input.busy && input.paired && input.now - input.lastActivityAt < 5 * 60_000;
}

/** Keep existing card order stable while new requests queue behind it. */
export function mergeHandoffs(previous: IntakeHandoff[], incoming: IntakeHandoff[], now: number): IntakeHandoff[] {
  const eligible = incoming.filter(row => Date.parse(row.expiresAt) > now && !['EXPIRED', 'REVOKED', 'CANCELLED'].includes(row.state));
  const byId = new Map(eligible.map(row => [row.id, row]));
  const result = previous.flatMap(row => { const next = byId.get(row.id); byId.delete(row.id); return next ? [row] : []; });
  return [...result, ...[...byId.values()].sort((a, b) => a.sequence - b.sequence)];
}

export function handoffPollDelay(failures: number): number { return Math.min(30_000, 2_000 * 2 ** Math.min(4, failures)); }
