import { canonicalize } from "../canonical.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { asEventData } from "./audit.js";
import { hashCanonicalManifest } from "./finalize.js";
import { loadProof } from "./proofs.js";
import {
  shipmentEventContentSha256,
  shipmentEventIntegritySha256,
} from "./shipment-event-hash.js";
import {
  listShipmentEventRowsAppendOrder,
  listShipmentEventRowsForShippingAppendOrder,
} from "./shipment-events.js";
import {
  DIGEST_ALGORITHM,
  SHIPMENT_INTEGRITY_SCHEMA,
  SHIPMENT_SUPPLEMENT_SCHEMA,
} from "./trust.js";
import {
  asRequiredIso,
  type ManifestRow,
  type ProofRow,
  type ShippingRow,
  type ShipmentEventRow,
} from "./types.js";

// Current supplement is recomputed from canonical rows. Nothing is persisted.
// A later event changes the digest; that is a new projection, not mutation of
// the core manifest or of earlier shipment_events.

export type ShipmentIntegrityStatus = "LINKED" | "CORE_NOT_FINALIZED" | "NO_SHIPMENT";

export interface CanonicalShipmentSupplement {
  schema: typeof SHIPMENT_SUPPLEMENT_SCHEMA;
  proofId: string;
  transactionId: string;
  coreManifestSha256: string;
  shipment: {
    shippingId: string;
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  };
  events: Array<{ shipmentEventId: string; sha256: string }>;
}

export interface ShipmentIntegrityVerification {
  coreManifestValid: boolean;
  eventContentHashesValid: boolean;
  eventChainValid: boolean;
  supplementValid: boolean;
  linkedToFinalizedProof: boolean;
  valid: boolean;
}

export interface ShipmentIntegrityView {
  schema: typeof SHIPMENT_INTEGRITY_SCHEMA;
  status: ShipmentIntegrityStatus;
  algorithm: typeof DIGEST_ALGORITHM;
  proofId: string;
  transactionId: string;
  shippingId: string | null;
  coreManifestSha256: string | null;
  shipmentSupplementSha256: string | null;
  eventCount: number;
  firstEventSha256: string | null;
  latestEventSha256: string | null;
  supplement: CanonicalShipmentSupplement | null;
  verification: ShipmentIntegrityVerification;
}

export function buildShipmentSupplement(input: {
  proofId: string;
  transactionId: string;
  coreManifestSha256: string;
  shipping: ShippingRow;
  events: ShipmentEventRow[];
}): CanonicalShipmentSupplement {
  return {
    schema: SHIPMENT_SUPPLEMENT_SCHEMA,
    proofId: input.proofId,
    transactionId: input.transactionId,
    coreManifestSha256: input.coreManifestSha256,
    shipment: {
      shippingId: input.shipping.id,
      carrier: input.shipping.carrier,
      service: input.shipping.service,
      trackingNumber: input.shipping.tracking_number,
      shipmentDate: input.shipping.shipment_date,
    },
    events: sortEventsAppendOrder(input.events).map((event) => ({
      shipmentEventId: event.id,
      sha256: event.sha256,
    })),
  };
}

export function shipmentSupplementSha256(supplement: CanonicalShipmentSupplement): string {
  return sha256Hex(canonicalize(supplement));
}

export async function getShipmentIntegrity(
  db: Database,
  proofId: string,
): Promise<ShipmentIntegrityView> {
  const proof = await loadProof(db, proofId);
  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [proof.transaction_id],
  );
  const shippingRow = shipping.rows[0] ?? null;
  const eventsByProof = await listShipmentEventRowsAppendOrder(db, proofId);
  const eventsByShipping = shippingRow
    ? await listShipmentEventRowsForShippingAppendOrder(db, shippingRow.id)
    : [];
  const associationValid = shipmentAssociationValid(
    proof,
    shippingRow,
    eventsByProof,
    eventsByShipping,
  );
  const eventContentHashesValid = eventsByProof.every((event) => eventContentHashValid(event));
  const eventChainValid = shipmentEventChainValid(proofId, eventsByProof);
  const core = await verifyStoredCoreManifest(db, proof);

  const base = {
    schema: SHIPMENT_INTEGRITY_SCHEMA,
    algorithm: DIGEST_ALGORITHM,
    proofId: proof.id,
    transactionId: proof.transaction_id,
    shippingId: shippingRow?.id ?? null,
    eventCount: eventsByProof.length,
    firstEventSha256: eventsByProof[0]?.sha256 ?? null,
    latestEventSha256: eventsByProof[eventsByProof.length - 1]?.sha256 ?? null,
  } as const;

  if (!shippingRow) {
    return {
      ...base,
      status: "NO_SHIPMENT",
      coreManifestSha256: core.storedSha256,
      shipmentSupplementSha256: null,
      supplement: null,
      verification: {
        coreManifestValid: core.valid,
        eventContentHashesValid,
        eventChainValid,
        supplementValid: false,
        linkedToFinalizedProof: false,
        valid: false,
      },
    };
  }

  if (proof.status !== "FINALIZED" || !core.storedSha256) {
    return {
      ...base,
      status: "CORE_NOT_FINALIZED",
      coreManifestSha256: core.storedSha256,
      shipmentSupplementSha256: null,
      supplement: null,
      verification: {
        coreManifestValid: false,
        eventContentHashesValid,
        eventChainValid,
        supplementValid: false,
        linkedToFinalizedProof: false,
        valid: false,
      },
    };
  }

  const supplement = buildShipmentSupplement({
    proofId: proof.id,
    transactionId: proof.transaction_id,
    coreManifestSha256: core.storedSha256,
    shipping: shippingRow,
    events: eventsByProof,
  });
  const digest = shipmentSupplementSha256(supplement);
  const recomputed = shipmentSupplementSha256(
    buildShipmentSupplement({
      proofId: proof.id,
      transactionId: proof.transaction_id,
      coreManifestSha256: core.storedSha256,
      shipping: shippingRow,
      events: eventsByProof,
    }),
  );
  const supplementValid =
    digest === recomputed &&
    associationValid &&
    supplementReflectsCanonicalState(
      supplement,
      proof,
      shippingRow,
      core.storedSha256,
      eventsByProof,
    );
  const linkedToFinalizedProof = core.valid && associationValid;
  const valid =
    core.valid &&
    eventContentHashesValid &&
    eventChainValid &&
    supplementValid &&
    linkedToFinalizedProof;

  return {
    ...base,
    status: "LINKED",
    coreManifestSha256: core.storedSha256,
    shipmentSupplementSha256: digest,
    supplement,
    verification: {
      coreManifestValid: core.valid,
      eventContentHashesValid,
      eventChainValid,
      supplementValid,
      linkedToFinalizedProof,
      valid,
    },
  };
}

export function eventContentHashValid(event: ShipmentEventRow): boolean {
  const recomputed = shipmentEventContentSha256({
    proofId: event.proof_id,
    transactionId: event.transaction_id,
    shippingId: event.shipping_id,
    eventType: event.event_type,
    occurredAt: asRequiredIso(event.occurred_at),
    carrier: event.carrier,
    locationText: event.location_text,
    source: event.source,
    provider: event.provider,
    sourceEventId: event.source_event_id,
    eventData: asEventData(event.event_data),
    payloadSha256: event.payload_sha256,
  });
  return recomputed === event.content_sha256;
}

export function shipmentEventChainValid(proofId: string, events: ShipmentEventRow[]): boolean {
  let previous: string | null = null;
  for (const event of sortEventsAppendOrder(events)) {
    const recomputed = shipmentEventIntegritySha256({
      contentSha256: event.content_sha256,
      previousEventSha256: event.previous_event_sha256,
      coreManifestSha256: event.core_manifest_sha256,
      proofId,
    });
    if (recomputed !== event.sha256) {
      return false;
    }
    if (event.previous_event_sha256 !== previous) {
      return false;
    }
    if (event.proof_id !== proofId) {
      return false;
    }
    previous = event.sha256;
  }
  return true;
}

async function verifyStoredCoreManifest(
  db: Database,
  proof: ProofRow,
): Promise<{ valid: boolean; storedSha256: string | null }> {
  if (proof.status !== "FINALIZED" || !proof.manifest_id) {
    return { valid: false, storedSha256: null };
  }
  const found = await db.query<ManifestRow>(
    `SELECT * FROM final_manifests WHERE proof_id = $1`,
    [proof.id],
  );
  const row = found.rows[0];
  if (!row) {
    return { valid: false, storedSha256: null };
  }
  try {
    const parsed = JSON.parse(row.canonical_json) as unknown;
    const hashed = hashCanonicalManifest(parsed);
    return {
      valid: hashed.sha256 === row.sha256,
      storedSha256: row.sha256,
    };
  } catch {
    return { valid: false, storedSha256: row.sha256 };
  }
}

function supplementReflectsCanonicalState(
  supplement: CanonicalShipmentSupplement,
  proof: ProofRow,
  shipping: ShippingRow,
  coreManifestSha256: string,
  events: ShipmentEventRow[],
): boolean {
  if (supplement.schema !== SHIPMENT_SUPPLEMENT_SCHEMA) {
    return false;
  }
  if (supplement.proofId !== proof.id || supplement.transactionId !== proof.transaction_id) {
    return false;
  }
  if (supplement.coreManifestSha256 !== coreManifestSha256) {
    return false;
  }
  if (
    supplement.shipment.shippingId !== shipping.id ||
    supplement.shipment.carrier !== shipping.carrier ||
    supplement.shipment.service !== shipping.service ||
    supplement.shipment.trackingNumber !== shipping.tracking_number ||
    supplement.shipment.shipmentDate !== shipping.shipment_date
  ) {
    return false;
  }
  const ordered = sortEventsAppendOrder(events);
  if (supplement.events.length !== ordered.length) {
    return false;
  }
  return ordered.every(
    (event, index) =>
      supplement.events[index]?.shipmentEventId === event.id &&
      supplement.events[index]?.sha256 === event.sha256,
  );
}

function sortEventsAppendOrder(events: ShipmentEventRow[]): ShipmentEventRow[] {
  return [...events].sort((left, right) => {
    const leftCreated = asRequiredIso(left.created_at);
    const rightCreated = asRequiredIso(right.created_at);
    if (leftCreated !== rightCreated) {
      return leftCreated < rightCreated ? -1 : 1;
    }
    return left.id < right.id ? -1 : 1;
  });
}

function shipmentAssociationValid(
  proof: ProofRow,
  shipping: ShippingRow | null,
  eventsByProof: ShipmentEventRow[],
  eventsByShipping: ShipmentEventRow[],
): boolean {
  if (!shipping) {
    return eventsByProof.length === 0;
  }
  if (shipping.transaction_id !== proof.transaction_id) {
    return false;
  }
  if (eventsByProof.length !== eventsByShipping.length) {
    return false;
  }
  for (let index = 0; index < eventsByProof.length; index += 1) {
    const event = eventsByProof[index];
    if (event.id !== eventsByShipping[index]?.id) {
      return false;
    }
    if (
      event.proof_id !== proof.id ||
      event.transaction_id !== proof.transaction_id ||
      event.shipping_id !== shipping.id
    ) {
      return false;
    }
  }
  return true;
}
