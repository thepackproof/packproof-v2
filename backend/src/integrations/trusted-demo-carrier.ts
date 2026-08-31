import { createHmac, timingSafeEqual } from "node:crypto";
import {
  providerAuthFailed,
  providerRateLimited,
  providerResponseInvalid,
  providerTemporarilyUnavailable,
  trackingNotFound,
  webhookReplayRejected,
  webhookSignatureInvalid,
} from "../domain/integration-errors.js";
import { normalizeShipmentEventType } from "../domain/shipment-event-types.js";
import type { IntegrationCredentials } from "./credentials.js";
import type {
  TrustedShipmentAdapter,
  TrustedTrackingObservation,
  TrustedTrackingSnapshot,
  VerifiedWebhookResult,
} from "./trusted-shipment-adapter.js";

export const TRUSTED_DEMO_CARRIER_ADAPTER_KEY = "trusted-demo-carrier";
export const TRUSTED_DEMO_CARRIER_PROVIDER = "trusted-demo-carrier";
export const TRUSTED_DEMO_API_KEY = "trusted-demo-secret";
export const TRUSTED_DEMO_WEBHOOK_SECRET = "trusted-demo-webhook-secret";
export const TRUSTED_DEMO_WEBHOOK_MAX_SKEW_SECONDS = 300;

const TIMELINE: TrustedTrackingObservation[] = [
  {
    eventType: "LABEL_CREATED",
    occurredAt: "2026-08-21T12:00:00.000Z",
    location: null,
    eventData: {},
  },
  {
    eventType: "CARRIER_ACCEPTED",
    occurredAt: "2026-08-21T16:08:00.000Z",
    location: null,
    eventData: {},
  },
  {
    eventType: "IN_TRANSIT",
    occurredAt: "2026-09-01T14:40:00.000Z",
    location: "Columbus, OH",
    eventData: {},
  },
];

export function createTrustedDemoCarrierAdapter(): TrustedShipmentAdapter {
  return {
    adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
    kind: "trusted",
    provider: TRUSTED_DEMO_CARRIER_PROVIDER,
    async getTrackingSnapshot(input) {
      assertLiveCredentials(input.credentials);
      const trackingNumber = input.trackingNumber.trim();
      if (!trackingNumber || trackingNumber === "UNKNOWN") {
        throw trackingNotFound();
      }
      if (trackingNumber === "INVALID-JSON") {
        throw providerResponseInvalid();
      }
      return {
        provider: TRUSTED_DEMO_CARRIER_PROVIDER,
        carrier: "DEMO",
        observations: TIMELINE.map((step) => ({
          ...step,
          sourceEventId: `${TRUSTED_DEMO_CARRIER_ADAPTER_KEY}:${input.transactionId}:${step.eventType}`,
        })),
      };
    },
    async verifyWebhook(input) {
      const secret = input.credentials.material.webhookSecret;
      if (!secret) {
        throw webhookSignatureInvalid();
      }
      const timestamp = headerValue(input.headers, "x-packproof-webhook-timestamp");
      const signature = headerValue(input.headers, "x-packproof-webhook-signature");
      if (!timestamp || !signature) {
        throw webhookSignatureInvalid();
      }
      const timestampMs = Number(timestamp) * 1000;
      if (!Number.isFinite(timestampMs)) {
        throw webhookReplayRejected();
      }
      const ageMs = Math.abs(Date.now() - timestampMs);
      if (ageMs > TRUSTED_DEMO_WEBHOOK_MAX_SKEW_SECONDS * 1000) {
        throw webhookReplayRejected();
      }
      const expected = signTrustedDemoWebhook(secret, timestamp, input.rawBody);
      if (!signaturesMatch(signature, expected)) {
        throw webhookSignatureInvalid();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.rawBody.toString("utf8")) as unknown;
      } catch {
        throw providerResponseInvalid();
      }
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw providerResponseInvalid();
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.eventId !== "string" || !record.eventId.trim()) {
        throw providerResponseInvalid();
      }
      if (typeof record.status !== "string" || !record.status.trim()) {
        throw providerResponseInvalid();
      }
      if (typeof record.occurredAt !== "string" || !record.occurredAt.trim()) {
        throw providerResponseInvalid();
      }
      const normalized = normalizeShipmentEventType(record.status);
      const trackingNumber =
        typeof record.trackingNumber === "string" ? record.trackingNumber.trim() : "";
      return {
        providerEventId: record.eventId.trim(),
        trackingNumber: trackingNumber || null,
        carrier: "DEMO",
        observations: [
          {
            sourceEventId: record.eventId.trim(),
            carrierStatus: normalized.carrierStatus,
            eventType: normalized.eventType,
            occurredAt: record.occurredAt,
            location: typeof record.location === "string" ? record.location : null,
            eventData: {},
          },
        ],
      };
    },
  };
}

export function signTrustedDemoWebhook(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

function assertLiveCredentials(credentials: IntegrationCredentials): void {
  const apiKey = credentials.material.apiKey;
  if (!apiKey || apiKey === "expired" || apiKey === "invalid") {
    throw providerAuthFailed();
  }
  if (apiKey === "rate-limited") {
    throw providerRateLimited();
  }
  if (apiKey === "down") {
    throw providerTemporarilyUnavailable();
  }
  if (apiKey !== TRUSTED_DEMO_API_KEY) {
    throw providerAuthFailed();
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const found = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(found)) {
    return found[0] ?? null;
  }
  return found ?? null;
}

function signaturesMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
