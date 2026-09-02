export type ChronologyCategory = "PROOF" | "COMMERCE" | "SHIPMENT" | string;

export interface TimelineEventModel {
  id: string;
  title: string;
  description: string | null;
  timeLabel: string;
  dateLabel: string;
  category: ChronologyCategory;
  sourceLabel: string;
  eventType: string;
  relatedEntityId: string | null;
  occurredAt: string;
  afterFinalization: boolean;
  icon: TimelineIcon;
}

export type TimelineIcon =
  | "created"
  | "person"
  | "commerce"
  | "package"
  | "video"
  | "check"
  | "lock"
  | "truck"
  | "event";

export function chronologyCategoryLabel(
  category: ChronologyCategory,
  source?: string,
  provider?: string | null,
  eventType?: string,
): string {
  if (category === "COMMERCE") {
    return "Commerce event";
  }
  if (category === "SHIPMENT") {
    if ((source ?? "").toUpperCase().includes("PARTICIPANT")) {
      return "Participant observation";
    }
    if ((provider ?? "").toLowerCase() === "easypost") {
      return "Carrier observation via EasyPost";
    }
    return "Carrier observation";
  }
  const type = (eventType ?? "").toUpperCase();
  if (type.includes("FINALIZE") || type.includes("MANIFEST") || type.includes("INTEGRITY")) {
    return "Integrity event";
  }
  if (type.includes("EVIDENCE") || type.includes("CAPTURE") || type.includes("ATTEST")) {
    return "Evidence event";
  }
  return "PackProof event";
}

export function humanChronologyTitle(eventType: string, fallbackTitle: string): string {
  switch (eventType.toUpperCase()) {
    case "EVIDENCE_COMMITTED":
      return "Packing video recorded";
    case "PROOF_FINALIZED":
      return "Proof finalized";
    case "PARTICIPANT_JOINED":
      return "Buyer joined";
    case "PARTICIPANT_INVITED":
      return "Buyer invited";
    default:
      return fallbackTitle;
  }
}

export function timelineIconFor(eventType: string, category: ChronologyCategory): TimelineIcon {
  const type = eventType.toUpperCase();
  if (type.includes("FINALIZE")) {
    return "lock";
  }
  if (type.includes("COMMIT") || type.includes("EVIDENCE_COMMITTED")) {
    return "check";
  }
  if (type.includes("EVIDENCE") || type.includes("CAPTURE") || type.includes("ATTEST")) {
    return "video";
  }
  if (type.includes("PARTICIPANT") || type.includes("INVIT") || type.includes("JOIN")) {
    return "person";
  }
  if (type.includes("IMPORT") || type.includes("PURCHASE") || type.includes("TRANSACTION") || category === "COMMERCE") {
    return "commerce";
  }
  if (category === "SHIPMENT" || type.includes("SHIP") || type.includes("CARRIER") || type.includes("LABEL")) {
    return type.includes("DELIVER") || type.includes("TRANSIT") || type.includes("ACCEPTED") ? "truck" : "package";
  }
  if (type.includes("CREATED") || type.includes("PROOF")) {
    return "created";
  }
  return "event";
}

export interface ChronologyLike {
  id: string;
  occurredAt: string;
  category: ChronologyCategory;
  title: string;
  description: string | null;
  source: string;
  provider?: string | null;
  relatedEntityId: string | null;
  eventType: string;
}

export function isShipmentAfterFinalization(
  entryOccurredAt: string,
  finalizedAt: string | null | undefined,
  category: ChronologyCategory,
): boolean {
  if (category !== "SHIPMENT" || !finalizedAt) {
    return false;
  }
  return new Date(entryOccurredAt).getTime() > new Date(finalizedAt).getTime();
}

export interface ShipmentEventLike {
  id: string;
  eventType: string;
  occurredAt: string;
  location: string | null;
  source: string;
  provider: string;
  eventData?: Record<string, unknown>;
}

export function weightFromEvent(event: ShipmentEventLike): string | null {
  const data = event.eventData ?? {};
  const candidates = [data.weight, data.mass, data.weightOz, data.weightLbs, data.pounds, data.ounces];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    if (typeof candidate === "number" || typeof candidate === "string") {
      return String(candidate);
    }
  }
  return null;
}
