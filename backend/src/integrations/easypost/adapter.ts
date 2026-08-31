import {
  providerResponseInvalid,
  webhookSignatureInvalid,
} from "../../domain/integration-errors.js";
import type {
  TrustedShipmentAdapter,
  TrustedTrackingSnapshot,
  VerifiedWebhookResult,
} from "../trusted-shipment-adapter.js";
import { createEasyPostTrackerClient, asTracker, type EasyPostTrackerClient } from "./client.js";
import { parseEasyPostCredentials } from "./credentials.js";
import { verifyEasyPostWebhookSignature } from "./hmac.js";
import { EASYPOST_PROVIDER, normalizeEasyPostTracker } from "./normalize.js";
import type { EasyPostEvent, EasyPostTracker } from "./types.js";

export const EASYPOST_TRACKER_ADAPTER_KEY = "easypost-tracker";

export function createEasyPostShipmentAdapter(
  client: EasyPostTrackerClient = createEasyPostTrackerClient(),
): TrustedShipmentAdapter {
  return {
    adapterKey: EASYPOST_TRACKER_ADAPTER_KEY,
    kind: "trusted",
    provider: EASYPOST_PROVIDER,
    async getTrackingSnapshot(input) {
      const credentials = parseEasyPostCredentials(input.credentials);
      const tracker = await retrieveTracker(client, {
        trackingNumber: input.trackingNumber,
        carrier: input.carrier ?? null,
        providerCursor: input.providerCursor ?? null,
        apiKey: credentials.apiKey,
      });
      assertTrackerMode(tracker, credentials.mode);
      return normalizeEasyPostTracker(tracker, input.carrier);
    },
    async verifyWebhook(input) {
      const credentials = parseEasyPostCredentials(input.credentials);
      if (!credentials.webhookSecret) {
        throw webhookSignatureInvalid();
      }
      verifyEasyPostWebhookSignature({
        headers: input.headers,
        rawBody: input.rawBody,
        webhookSecret: credentials.webhookSecret,
      });
      const event = parseEvent(input.rawBody);
      assertEventMode(event, credentials.mode);
      const tracker = event.result ? asTracker(event.result) : null;
      const providerEventId =
        typeof event.id === "string" && event.id.trim() ? event.id.trim() : "";
      if (!providerEventId) {
        throw providerResponseInvalid();
      }
      if (!tracker) {
        return {
          providerEventId,
          trackingNumber: null,
          carrier: null,
          observations: [],
        };
      }
      const snapshot = normalizeEasyPostTracker(tracker);
      return {
        providerEventId,
        trackingNumber: tracker.tracking_code?.trim() || null,
        carrier: snapshot.carrier,
        observations: snapshot.observations,
      };
    },
  };
}

async function retrieveTracker(
  client: EasyPostTrackerClient,
  input: {
    trackingNumber: string;
    carrier: string | null;
    providerCursor: string | null;
    apiKey: string;
  },
): Promise<EasyPostTracker> {
  const trackingNumber = input.trackingNumber.trim();
  if (!trackingNumber) {
    throw providerResponseInvalid();
  }
  const cursor = input.providerCursor?.trim() ?? "";
  if (cursor.startsWith("trk_")) {
    try {
      return await client.getTracker({ trackerId: cursor, apiKey: input.apiKey });
    } catch (error) {
      if (!isTrackingMiss(error)) {
        throw error;
      }
    }
  }
  return client.createTracker({
    trackingCode: trackingNumber,
    carrier: input.carrier,
    apiKey: input.apiKey,
  });
}

function isTrackingMiss(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "TRACKING_NOT_FOUND",
  );
}

function assertTrackerMode(tracker: EasyPostTracker, expected: "test" | "production"): void {
  const mode = typeof tracker.mode === "string" ? tracker.mode.trim().toLowerCase() : "";
  if (!mode) {
    return;
  }
  if (expected === "test" && mode === "production") {
    throw providerResponseInvalid();
  }
}

function assertEventMode(event: EasyPostEvent, expected: "test" | "production"): void {
  const mode = typeof event.mode === "string" ? event.mode.trim().toLowerCase() : "";
  if (expected === "test" && mode === "production") {
    throw providerResponseInvalid();
  }
}

function parseEvent(rawBody: Buffer): EasyPostEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw providerResponseInvalid();
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw providerResponseInvalid();
  }
  return parsed as EasyPostEvent;
}

export function easypostCredentialReferenceAllowed(reference: string): boolean {
  return (
    reference.startsWith("env:") ||
    reference.startsWith("sm:") ||
    reference.startsWith("packproof/") ||
    reference.startsWith("arn:aws:secretsmanager:") ||
    reference.startsWith("memory:")
  );
}
