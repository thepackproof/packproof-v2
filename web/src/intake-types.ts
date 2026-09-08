export interface IntakeSnapshot {
  id: string; version: number; digest: string; proofId: string; transactionId: string;
  items: Array<{title: string | null; quantity: number | null; variant?: string | null}>;
  store: string; orderReference: string; sourceKind: string;
}
export interface IntakeOrder {
  observationId: string; readiness: string; reasons: string[];
  transactionId: string | null; proofId: string | null; snapshot: IntakeSnapshot | null;
}
export interface IntakeCapabilities {
  enabled: boolean; handoffEnabled: boolean; emailEnabled: boolean; browserEnabled: boolean;
  shippoEnabled: boolean; mailDomainConfigured: boolean;
}
export interface IntakeDevice {id: string; name: string; state: string; approvedAt?: string | null; revokedAt?: string | null;}
export interface MailSetup {
  id: string; address: string; connectionId: string; store: string; state: string;
  lastErrorCode: string | null; supportedTemplates: string[];
  challenge: {id: string; code: string | null; url: string | null; expiresAt: string} | null;
}
export function intakePreferenceKey(apiScope: string, userId: string): string {
  return `packproof:intake:${apiScope}:${userId}`;
}
