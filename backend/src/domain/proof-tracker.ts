import type { Database } from "../db/database.js";
import { DomainError } from "./errors.js";

export const TRACKER_MILESTONE_CODES = [
  "PROOF_CREATED",
  "PACKING_RECORDED",
  "PROOF_FINALIZED",
  "CARRIER_ACCEPTED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

export type TrackerMilestoneCode = (typeof TRACKER_MILESTONE_CODES)[number];
export type TrackerMilestoneState = "COMPLETE" | "CURRENT" | "UPCOMING";

export interface ProofTrackerMilestone {
  code: TrackerMilestoneCode;
  label: string;
  state: TrackerMilestoneState;
  occurredAt: string | null;
  detail: string | null;
}

export interface ProofTrackerView {
  state: "IN_PROGRESS" | "FINALIZED";
  headline: string;
  reference: string | null;
  itemTitle: string | null;
  lastUpdatedAt: string;
  shipment: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
  } | null;
  milestones: ProofTrackerMilestone[];
}

/** The same visibility rules apply to browser projections and emailed updates. */
export function trackerForScope(tracker: ProofTrackerView, scope: string): ProofTrackerView {
  if (scope !== "STATUS_ONLY") return tracker;
  return {
    ...tracker,
    reference: null,
    itemTitle: null,
    shipment: null,
    milestones: tracker.milestones.map((milestone) => ({ ...milestone, detail: null })),
  };
}

type TrackerRow = {
  proof_id: string;
  status: string;
  created_at: Date | string;
  finalized_at: Date | string | null;
  external_reference: string | null;
  item_title: string | null;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
};

type ShipmentEventRow = {
  event_type: string;
  occurred_at: Date | string;
  location_text: string | null;
  carrier: string | null;
};

export async function buildProofTracker(db: Database, proofId: string): Promise<ProofTrackerView> {
  const proofResult = await db.query<TrackerRow>(
    `SELECT p.id AS proof_id,
            p.status,
            p.created_at,
            p.finalized_at,
            t.external_reference,
            t.item_title,
            s.carrier,
            s.service,
            s.tracking_number
       FROM proofs p
       JOIN transactions t ON t.id = p.transaction_id
       LEFT JOIN transaction_shipping s ON s.transaction_id = t.id
      WHERE p.id = $1`,
    [proofId],
  );
  const row = proofResult.rows[0];
  if (!row) {
    throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  }

  const packingResult = await db.query<{ occurred_at: Date | string }>(
    `SELECT occurred_at
       FROM (
         SELECT committed_at AS occurred_at
           FROM evidence
          WHERE proof_id = $1
            AND validation_status = 'COMMITTED'
            AND evidence_type = 'FULFILLMENT_CAPTURE'
            AND committed_at IS NOT NULL
         UNION ALL
         SELECT occurred_at
           FROM custody_observations
          WHERE proof_id = $1
            AND observation_type = 'PACKED'
       ) packing_events
      ORDER BY occurred_at ASC
      LIMIT 1`,
    [proofId],
  );

  const shipmentResult = await db.query<ShipmentEventRow>(
    `SELECT event_type, occurred_at, location_text, carrier
       FROM shipment_events
      WHERE proof_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [proofId],
  );

  const shipmentEvents = shipmentResult.rows;
  const occurred = new Map<TrackerMilestoneCode, { at: string; detail: string | null }>();
  occurred.set("PROOF_CREATED", { at: toIso(row.created_at), detail: null });

  const packing = packingResult.rows[0];
  if (packing) {
    occurred.set("PACKING_RECORDED", {
      at: toIso(packing.occurred_at),
      detail: "Packing evidence was committed to this Proof.",
    });
  }
  if (row.finalized_at) {
    occurred.set("PROOF_FINALIZED", {
      at: toIso(row.finalized_at),
      detail: "The core evidence record was finalized.",
    });
  }

  addShipmentMilestone(occurred, shipmentEvents, "CARRIER_ACCEPTED", ["CARRIER_ACCEPTED"]);
  addShipmentMilestone(occurred, shipmentEvents, "IN_TRANSIT", [
    "IN_TRANSIT",
    "ARRIVED_AT_FACILITY",
    "DEPARTED_FACILITY",
  ]);
  addShipmentMilestone(occurred, shipmentEvents, "OUT_FOR_DELIVERY", ["OUT_FOR_DELIVERY"]);
  addShipmentMilestone(occurred, shipmentEvents, "DELIVERED", ["DELIVERED"]);

  const completed = new Set(occurred.keys());
  const firstUpcomingIndex = TRACKER_MILESTONE_CODES.findIndex((code) => !completed.has(code));
  const milestones = TRACKER_MILESTONE_CODES.map((code, index): ProofTrackerMilestone => {
    const hit = occurred.get(code);
    return {
      code,
      label: milestoneLabel(code),
      state: hit
        ? "COMPLETE"
        : firstUpcomingIndex === index
          ? "CURRENT"
          : "UPCOMING",
      occurredAt: hit?.at ?? null,
      detail: hit?.detail ?? null,
    };
  });

  const lastUpdatedAt = Array.from(occurred.values())
    .map((event) => event.at)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? toIso(row.created_at);

  return {
    state: row.status === "FINALIZED" ? "FINALIZED" : "IN_PROGRESS",
    headline: trackerHeadline(completed, row.status),
    reference: row.external_reference,
    itemTitle: row.item_title,
    lastUpdatedAt,
    shipment:
      row.carrier || row.service || row.tracking_number
        ? {
            carrier: row.carrier,
            service: row.service,
            trackingNumber: row.tracking_number,
          }
        : null,
    milestones,
  };
}

function addShipmentMilestone(
  target: Map<TrackerMilestoneCode, { at: string; detail: string | null }>,
  events: ShipmentEventRow[],
  code: TrackerMilestoneCode,
  eventTypes: string[],
): void {
  const event = events.find((candidate) => eventTypes.includes(candidate.event_type));
  if (!event) {
    return;
  }
  target.set(code, {
    at: toIso(event.occurred_at),
    detail: event.location_text || event.carrier || null,
  });
}

function milestoneLabel(code: TrackerMilestoneCode): string {
  switch (code) {
    case "PROOF_CREATED":
      return "Proof created";
    case "PACKING_RECORDED":
      return "Packing evidence recorded";
    case "PROOF_FINALIZED":
      return "Evidence record finalized";
    case "CARRIER_ACCEPTED":
      return "Carrier accepted package";
    case "IN_TRANSIT":
      return "In transit";
    case "OUT_FOR_DELIVERY":
      return "Out for delivery";
    case "DELIVERED":
      return "Delivered";
  }
}

function trackerHeadline(completed: Set<TrackerMilestoneCode>, proofStatus: string): string {
  if (completed.has("DELIVERED")) return "Delivered";
  if (completed.has("OUT_FOR_DELIVERY")) return "Out for delivery";
  if (completed.has("IN_TRANSIT")) return "In transit";
  if (completed.has("CARRIER_ACCEPTED")) return "Carrier accepted package";
  if (proofStatus === "FINALIZED") return "Proof finalized";
  if (completed.has("PACKING_RECORDED")) return "Packing evidence recorded";
  return "Proof in progress";
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
