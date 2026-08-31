import type { IntegrationCredentials } from "./credentials.js";

export interface TrustedTrackingObservation {
  sourceEventId?: string | null;
  carrierStatus?: string | null;
  eventType?: string | null;
  occurredAt: string;
  location?: string | null;
  eventData?: Record<string, unknown>;
}

export interface TrustedTrackingSnapshot {
  provider: string;
  carrier: string | null;
  observations: TrustedTrackingObservation[];
  providerCursor?: string | null;
  mode?: string | null;
}

export interface VerifiedWebhookResult {
  providerEventId: string;
  trackingNumber: string | null;
  carrier?: string | null;
  observations: TrustedTrackingObservation[];
}

export interface TrustedShipmentAdapter {
  readonly adapterKey: string;
  readonly kind: "trusted";
  readonly provider: string;
  getTrackingSnapshot(input: {
    trackingNumber: string;
    transactionId: string;
    externalTransactionId: string | null;
    carrier?: string | null;
    providerCursor?: string | null;
    credentials: IntegrationCredentials;
  }): Promise<TrustedTrackingSnapshot>;
  verifyWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
    credentials: IntegrationCredentials;
  }): Promise<VerifiedWebhookResult>;
}
