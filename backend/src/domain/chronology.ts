import type { AuditEventView } from "./audit.js";
import type { ShipmentEventView } from "./shipment-events.js";
import type { TransactionView } from "./transaction-fields.js";

export const CHRONOLOGY_CATEGORIES = ["PROOF", "COMMERCE", "SHIPMENT"] as const;
export type ChronologyCategory = (typeof CHRONOLOGY_CATEGORIES)[number];

export interface ChronologyEntry {
  id: string;
  occurredAt: string;
  category: ChronologyCategory;
  title: string;
  description: string | null;
  source: string;
  relatedEntityId: string | null;
  eventType: string;
}

const SKIP_AUDIT_TYPES = new Set([
  "EVIDENCE_UPLOAD_CREATED",
  "SHIPMENT_EVENT_RECORDED",
  "EXTERNAL_REFERENCE_BOUND",
  "TRANSACTION_DETAILS_UPDATED",
]);

export function buildChronology(input: {
  transaction: TransactionView;
  events: AuditEventView[];
  shipmentEvents: ShipmentEventView[];
}): ChronologyEntry[] {
  const entries: ChronologyEntry[] = [];
  for (const event of input.events) {
    if (SKIP_AUDIT_TYPES.has(event.eventType)) {
      continue;
    }
    const mapped = mapAuditEvent(event, input.transaction);
    if (mapped) {
      entries.push(mapped);
    }
  }
  for (const event of input.shipmentEvents) {
    entries.push(mapShipmentEvent(event));
  }
  entries.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) {
      return a.occurredAt.localeCompare(b.occurredAt);
    }
    return a.id.localeCompare(b.id);
  });
  return entries;
}

function mapAuditEvent(event: AuditEventView, transaction: TransactionView): ChronologyEntry | null {
  const shipping = transaction.shipping;
  switch (event.eventType) {
    case "PROOF_CREATED":
      return entry(event, "PROOF", "Proof created", null, "PACKPROOF");
    case "TRANSACTION_IMPORTED":
      return entry(
        event,
        "COMMERCE",
        "Transaction imported",
        sourceDescription(event) ?? "Marketplace",
        eventSource(event, "MARKETPLACE_API"),
      );
    case "SHIPPING_DETAILS_IMPORTED":
      return entry(
        event,
        "COMMERCE",
        shippingLabel(shipping),
        shipping?.trackingNumber ? `Tracking: ${shipping.trackingNumber}` : null,
        eventSource(event, "MARKETPLACE_API"),
      );
    case "SHIPPING_DETAILS_UPDATED":
      return entry(event, "COMMERCE", "Shipping details updated", null, "PARTICIPANT_SUPPLIED");
    case "PARTICIPANT_INVITED":
      return entry(event, "PROOF", "Participant invited", null, "PACKPROOF");
    case "PARTICIPANT_JOINED":
      return entry(event, "PROOF", "Participant joined", null, "PACKPROOF");
    case "EVIDENCE_COMMITTED":
      return entry(event, "PROOF", "Packing evidence committed", "Integrity confirmed", "PACKPROOF");
    case "ATTESTATION_COMMITTED":
      return entry(event, "PROOF", "Attestation recorded", null, "PACKPROOF");
    case "PROOF_FINALIZED": {
      const hash = typeof event.data.sha256 === "string" ? event.data.sha256 : null;
      return entry(
        event,
        "PROOF",
        "Core PackProof finalized",
        hash ? `Manifest hash ${hash}` : null,
        "PACKPROOF",
      );
    }
    default:
      return entry(
        event,
        "PROOF",
        titleFromType(event.eventType),
        null,
        "PACKPROOF",
      );
  }
}

function mapShipmentEvent(event: ShipmentEventView): ChronologyEntry {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    category: "SHIPMENT",
    title: shipmentTitle(event),
    description: shipmentDescription(event),
    source: event.source,
    relatedEntityId: event.id,
    eventType: event.eventType,
  };
}

function shipmentTitle(event: ShipmentEventView): string {
  const carrier = event.carrier;
  switch (event.eventType) {
    case "LABEL_CREATED":
      return "Label created";
    case "CARRIER_ACCEPTED":
      return carrier ? `Package accepted by ${carrier}` : "Package accepted";
    case "WEIGHT_RECORDED": {
      const weight = event.eventData.weightLb;
      const unit = typeof event.eventData.unit === "string" ? event.eventData.unit : "lb";
      if (typeof weight === "number") {
        return `Recorded weight: ${weight} ${unit}`;
      }
      return "Weight recorded";
    }
    case "IN_TRANSIT":
      return "In transit";
    case "ARRIVED_AT_FACILITY":
      return "Arrived at facility";
    case "DEPARTED_FACILITY":
      return "Departed facility";
    case "OUT_FOR_DELIVERY":
      return "Out for delivery";
    case "DELIVERED":
      return "Delivered";
    case "DELIVERY_EXCEPTION":
      return "Delivery exception";
    case "RETURN_TO_SENDER":
      return "Return to sender";
    case "RETURN_IN_TRANSIT":
      return "Return in transit";
    case "RETURN_DELIVERED":
      return "Return delivered";
    case "CARRIER_EVENT": {
      const status = event.eventData.carrierStatus;
      return typeof status === "string" && status.trim() ? status.trim() : "Carrier event";
    }
    default:
      return titleFromType(event.eventType);
  }
}

function shipmentDescription(event: ShipmentEventView): string | null {
  return event.location;
}

function shippingLabel(
  shipping: TransactionView["shipping"],
): string {
  if (!shipping) {
    return "Shipping label associated";
  }
  const parts = [shipping.carrier, shipping.service].filter(Boolean);
  if (parts.length === 0) {
    return "Shipping label associated";
  }
  return `${parts.join(" ")} label associated`;
}

function entry(
  event: AuditEventView,
  category: ChronologyCategory,
  title: string,
  description: string | null,
  source: string,
): ChronologyEntry {
  return {
    id: event.eventId,
    occurredAt: event.at,
    category,
    title,
    description,
    source,
    relatedEntityId: event.eventId,
    eventType: event.eventType,
  };
}

function eventSource(event: AuditEventView, fallback: string): string {
  return typeof event.data.source === "string" ? event.data.source : fallback;
}

function sourceDescription(event: AuditEventView): string | null {
  if (typeof event.data.adapterKey === "string" && event.data.adapterKey.trim()) {
    return event.data.adapterKey === "demo-marketplace" ? "Marketplace" : event.data.adapterKey;
  }
  if (typeof event.data.provider === "string") {
    return event.data.provider;
  }
  return null;
}

function titleFromType(eventType: string): string {
  return eventType.replaceAll("_", " ").toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}
