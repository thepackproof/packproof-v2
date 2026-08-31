import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";

export interface ShipmentEventCanonicalContent {
  proofId: string;
  transactionId: string;
  shippingId: string;
  eventType: string;
  occurredAt: string;
  carrier: string | null;
  locationText: string | null;
  source: string;
  provider: string;
  sourceEventId: string | null;
  eventData: Record<string, unknown>;
  payloadSha256: string | null;
}

export function canonicalizeShipmentEventContent(
  input: ShipmentEventCanonicalContent,
): string {
  return canonicalize({
    proofId: input.proofId,
    transactionId: input.transactionId,
    shippingId: input.shippingId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    carrier: input.carrier,
    locationText: input.locationText,
    source: input.source,
    provider: input.provider,
    sourceEventId: input.sourceEventId,
    eventData: input.eventData,
    payloadSha256: input.payloadSha256,
  });
}

export function shipmentEventContentSha256(input: ShipmentEventCanonicalContent): string {
  return sha256Hex(canonicalizeShipmentEventContent(input));
}

export function shipmentEventIntegritySha256(input: {
  contentSha256: string;
  previousEventSha256: string | null;
  coreManifestSha256: string | null;
  proofId: string;
}): string {
  return sha256Hex(
    canonicalize({
      contentSha256: input.contentSha256,
      previousEventSha256: input.previousEventSha256,
      coreManifestSha256: input.coreManifestSha256,
      proofId: input.proofId,
    }),
  );
}

export function shipmentEventDedupeFingerprint(input: {
  transactionId: string;
  shippingId: string;
  provider: string;
  eventType: string;
  occurredAt: string;
  carrier: string | null;
  locationText: string | null;
  eventData: Record<string, unknown>;
}): string {
  return sha256Hex(canonicalize(input));
}
