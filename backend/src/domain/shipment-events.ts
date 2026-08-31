import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit, asEventData } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import type { ImportedShipmentEvent } from "./imported-shipment-event.js";
import { isProvenanceSource, type ProvenanceSource } from "./provenance.js";
import {
  shipmentEventContentSha256,
  shipmentEventDedupeFingerprint,
  shipmentEventIntegritySha256,
} from "./shipment-event-hash.js";
import {
  normalizeShipmentEventType,
  type ShipmentEventType,
} from "./shipment-event-types.js";
import { insertShipping, lockTransactionContext, type TransactionBundle } from "./transactions.js";
import {
  asRequiredIso,
  type ManifestRow,
  type ProofRow,
  type ShippingRow,
} from "./types.js";

const FORBIDDEN_EVENT_DATA_KEYS = [
  "authorization",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "api_key",
  "apikey",
  "client_secret",
  "clientsecret",
  "password",
  "secret",
  "token",
  "credentials",
  "cookie",
  "rawauthorization",
];

const EVENT_DATA_MAX_BYTES = 8192;

export interface ShipmentEventView {
  id: string;
  proofId: string;
  transactionId: string;
  shippingId: string;
  eventType: string;
  occurredAt: string;
  observedAt: string;
  source: string;
  provider: string;
  carrier: string | null;
  location: string | null;
  eventData: Record<string, unknown>;
  sha256: string;
  contentSha256: string;
  previousEventSha256: string | null;
  coreManifestSha256: string | null;
  payloadSha256: string | null;
  sourceEventId: string | null;
}

export interface ShipmentObservationsView {
  shippingId: string | null;
  identity: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  } | null;
  events: ShipmentEventView[];
  latest: ShipmentEventView | null;
}

export interface RecordShipmentEventInput {
  transactionId: string;
  eventType: unknown;
  occurredAt: unknown;
  carrier?: unknown;
  locationText?: unknown;
  source: unknown;
  provider: unknown;
  sourceEventId?: unknown;
  eventData?: unknown;
  payloadSha256?: unknown;
  authority: "INTEGRATION" | "PARTICIPANT";
}

export interface RecordShipmentEventResult {
  event: ShipmentEventView;
  created: boolean;
}

export interface ImportShipmentObservationsResult {
  transactionId: string;
  proofId: string;
  events: ShipmentEventView[];
  createdCount: number;
}

interface ShipmentEventRow {
  id: string;
  proof_id: string;
  transaction_id: string;
  shipping_id: string;
  event_type: string;
  occurred_at: Date | string;
  observed_at: Date | string;
  created_at: Date | string;
  carrier: string | null;
  location_text: string | null;
  source: string;
  provider: string;
  source_event_id: string | null;
  event_data: unknown;
  payload_sha256: string | null;
  content_sha256: string;
  previous_event_sha256: string | null;
  core_manifest_sha256: string | null;
  sha256: string;
  dedupe_fingerprint: string;
}

export async function recordShipmentEvent(
  db: Database,
  clock: Clock,
  actorUserId: string,
  input: RecordShipmentEventInput,
): Promise<RecordShipmentEventResult> {
  const parsed = parseRecordInput(input);
  return db.transaction(async (tx) => {
    const locked = await lockTransactionContext(tx, parsed.transactionId);
    await assertCanRecord(tx, actorUserId, locked, parsed.authority);
    if (!locked.proofId) {
      throw new DomainError(
        "SHIPMENT_EVENT_PROOF_REQUIRED",
        "A Proof must exist before shipment observations can be recorded",
        422,
      );
    }
    await tx.query(`SELECT id FROM proofs WHERE id = $1 FOR UPDATE`, [locked.proofId]);
    const shipping = await ensureShippingIdentity(tx, locked, parsed.carrier, clock.now().toISOString());
    await tx.query(`SELECT id FROM shipment_events WHERE shipping_id = $1 FOR UPDATE`, [shipping.id]);

    const contentInput = {
      proofId: locked.proofId,
      transactionId: locked.txn.id,
      shippingId: shipping.id,
      eventType: parsed.eventType,
      occurredAt: parsed.occurredAt,
      carrier: parsed.carrier,
      locationText: parsed.locationText,
      source: parsed.source,
      provider: parsed.provider,
      sourceEventId: parsed.sourceEventId,
      eventData: parsed.eventData,
      payloadSha256: parsed.payloadSha256,
    };
    const contentSha256 = shipmentEventContentSha256(contentInput);
    const fingerprint = shipmentEventDedupeFingerprint({
      transactionId: locked.txn.id,
      shippingId: shipping.id,
      provider: parsed.provider,
      eventType: parsed.eventType,
      occurredAt: parsed.occurredAt,
      carrier: parsed.carrier,
      locationText: parsed.locationText,
      eventData: parsed.eventData,
    });

    const existing = await findExistingEvent(tx, {
      provider: parsed.provider,
      sourceEventId: parsed.sourceEventId,
      transactionId: locked.txn.id,
      fingerprint,
    });
    if (existing) {
      assertSameEventIdentity(existing, locked.proofId, locked.txn.id, contentSha256);
      return { event: toView(existing), created: false };
    }

    const proof = await tx.query<ProofRow>(`SELECT * FROM proofs WHERE id = $1`, [locked.proofId]);
    const proofRow = proof.rows[0];
    const coreManifestSha256 = await loadCoreManifestSha256(tx, proofRow);
    const previous = await tx.query<{ sha256: string }>(
      `SELECT sha256 FROM shipment_events
        WHERE shipping_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [shipping.id],
    );
    const previousEventSha256 = previous.rows[0]?.sha256 ?? null;
    const sha256 = shipmentEventIntegritySha256({
      contentSha256,
      previousEventSha256,
      coreManifestSha256,
      proofId: locked.proofId,
    });
    const now = clock.now();
    const id = newId("sev");
    try {
      await tx.query(
        `INSERT INTO shipment_events (
           id, proof_id, transaction_id, shipping_id, event_type,
           occurred_at, observed_at, created_at, carrier, location_text,
           source, provider, source_event_id, event_data, payload_sha256,
           content_sha256, previous_event_sha256, core_manifest_sha256,
           sha256, dedupe_fingerprint
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13, $14::jsonb, $15,
           $16, $17, $18,
           $19, $20
         )`,
        [
          id,
          locked.proofId,
          locked.txn.id,
          shipping.id,
          parsed.eventType,
          parsed.occurredAt,
          now.toISOString(),
          now.toISOString(),
          parsed.carrier,
          parsed.locationText,
          parsed.source,
          parsed.provider,
          parsed.sourceEventId,
          JSON.stringify(parsed.eventData),
          parsed.payloadSha256,
          contentSha256,
          previousEventSha256,
          coreManifestSha256,
          sha256,
          fingerprint,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await findExistingEvent(tx, {
          provider: parsed.provider,
          sourceEventId: parsed.sourceEventId,
          transactionId: locked.txn.id,
          fingerprint,
        });
        if (raced) {
          assertSameEventIdentity(raced, locked.proofId, locked.txn.id, contentSha256);
          return { event: toView(raced), created: false };
        }
        throw new DomainError(
          "SHIPMENT_EVENT_CONFLICT",
          "Shipment event identity conflicts with an existing observation",
          409,
        );
      }
      throw error;
    }

    await appendAudit(tx, {
      proofId: locked.proofId,
      actorUserId,
      eventType: "SHIPMENT_EVENT_RECORDED",
      eventData: {
        shipmentEventId: id,
        eventType: parsed.eventType,
        source: parsed.source,
        provider: parsed.provider,
      },
      at: now,
    });

    const inserted = await tx.query<ShipmentEventRow>(
      `SELECT * FROM shipment_events WHERE id = $1`,
      [id],
    );
    return { event: toView(inserted.rows[0]), created: true };
  });
}

export async function importShipmentObservations(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  observations: ImportedShipmentEvent[],
): Promise<ImportShipmentObservationsResult> {
  return db.transaction(async (tx) => {
    const events: ShipmentEventView[] = [];
    let createdCount = 0;
    let proofId = "";
    for (const observation of observations) {
      const recorded = await recordShipmentEvent(tx, clock, actorUserId, {
        transactionId,
        eventType: observation.eventType,
        occurredAt: observation.occurredAt,
        carrier: observation.carrier,
        locationText: observation.locationText,
        source: observation.source,
        provider: observation.provider,
        sourceEventId: observation.sourceEventId,
        eventData: observation.eventData,
        payloadSha256: observation.payloadSha256,
        authority: "INTEGRATION",
      });
      events.push(recorded.event);
      if (recorded.created) {
        createdCount += 1;
      }
      proofId = recorded.event.proofId;
    }
    return { transactionId, proofId, events, createdCount };
  });
}

export async function recordParticipantShipmentEvent(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  body: unknown,
): Promise<RecordShipmentEventResult> {
  const record =
    body != null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return recordShipmentEvent(db, clock, actorUserId, {
    transactionId,
    eventType: record.eventType,
    occurredAt: record.occurredAt,
    carrier: record.carrier,
    locationText: record.locationText ?? record.location,
    source: "PARTICIPANT_SUPPLIED",
    provider: "participant",
    sourceEventId: record.sourceEventId ?? null,
    eventData: participantEventData(record.eventData),
    payloadSha256: null,
    authority: "PARTICIPANT",
  });
}

function participantEventData(value: unknown): Record<string, unknown> {
  const record =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  delete record.source;
  delete record.provider;
  return record;
}

export async function listShipmentEventsForProof(
  db: Database,
  proofId: string,
): Promise<ShipmentEventView[]> {
  const result = await db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events
      WHERE proof_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [proofId],
  );
  return result.rows.map(toView);
}

export async function listShipmentEventRowsAppendOrder(
  db: Database,
  proofId: string,
): Promise<ShipmentEventRow[]> {
  const result = await db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events
      WHERE proof_id = $1
      ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return result.rows;
}

export async function listShipmentEventRowsForShippingAppendOrder(
  db: Database,
  shippingId: string,
): Promise<ShipmentEventRow[]> {
  const result = await db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events
      WHERE shipping_id = $1
      ORDER BY created_at ASC, id ASC`,
    [shippingId],
  );
  return result.rows;
}

export async function listShipmentEventsForTransaction(
  db: Database,
  transactionId: string,
): Promise<ShipmentEventView[]> {
  const result = await db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events
      WHERE transaction_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [transactionId],
  );
  return result.rows.map(toView);
}

export async function getShipmentObservationsForProof(
  db: Database,
  proofId: string,
  transactionId: string,
): Promise<ShipmentObservationsView> {
  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [transactionId],
  );
  const events = await listShipmentEventsForProof(db, proofId);
  const row = shipping.rows[0] ?? null;
  return {
    shippingId: row?.id ?? null,
    identity: row
      ? {
          carrier: row.carrier,
          service: row.service,
          trackingNumber: row.tracking_number,
          shipmentDate: row.shipment_date,
        }
      : null,
    events,
    latest: events[events.length - 1] ?? null,
  };
}

export async function resolveTransactionIdForShipmentImport(
  db: Database,
  actorUserId: string,
  input: { transactionId: string | null; externalTransactionId: string | null },
): Promise<string> {
  if (input.transactionId) {
    const locked = await lockTransactionContext(db, input.transactionId);
    await assertCanRecord(db, actorUserId, locked, "INTEGRATION");
    return locked.txn.id;
  }
  const externalId = input.externalTransactionId;
  if (!externalId) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "transactionId or externalTransactionId is required", 400);
  }
  const identities = await db.query<{ transaction_id: string }>(
    `SELECT i.transaction_id
       FROM transaction_integration_identities i
       JOIN transactions t ON t.id = i.transaction_id
      WHERE i.external_transaction_id = $1
        AND t.created_by = $2
      ORDER BY i.created_at ASC, i.id ASC`,
    [externalId, actorUserId],
  );
  if (identities.rows.length === 1) {
    return identities.rows[0].transaction_id;
  }
  if (identities.rows.length > 1) {
    throw new DomainError(
      "SHIPMENT_EVENT_CONFLICT",
      "externalTransactionId matches more than one transaction",
      409,
    );
  }
  const byReference = await db.query<{ id: string }>(
    `SELECT id FROM transactions WHERE external_reference = $1 AND created_by = $2`,
    [externalId, actorUserId],
  );
  if (byReference.rows.length === 1) {
    return byReference.rows[0].id;
  }
  if (byReference.rows.length > 1) {
    throw new DomainError(
      "SHIPMENT_EVENT_CONFLICT",
      "externalTransactionId matches more than one transaction",
      409,
    );
  }
  throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
}

export function sliceTimelineThrough(
  observations: ImportedShipmentEvent[],
  throughEventType: string | null,
): ImportedShipmentEvent[] {
  if (!throughEventType) {
    return observations;
  }
  const wanted = normalizeShipmentEventType(throughEventType).eventType;
  const index = observations.findIndex(
    (observation) => normalizeShipmentEventType(observation.eventType).eventType === wanted,
  );
  if (index < 0) {
    throw new DomainError(
      "INVALID_SHIPMENT_EVENT",
      "throughEventType is not present on this adapter timeline",
      400,
    );
  }
  return observations.slice(0, index + 1);
}

function parseRecordInput(input: RecordShipmentEventInput): {
  transactionId: string;
  eventType: ShipmentEventType;
  occurredAt: string;
  carrier: string | null;
  locationText: string | null;
  source: ProvenanceSource;
  provider: string;
  sourceEventId: string | null;
  eventData: Record<string, unknown>;
  payloadSha256: string | null;
  authority: "INTEGRATION" | "PARTICIPANT";
} {
  if (typeof input.transactionId !== "string" || !input.transactionId.trim()) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "transactionId is required", 400);
  }
  const normalized = normalizeShipmentEventType(input.eventType);
  const source =
    input.authority === "PARTICIPANT"
      ? "PARTICIPANT_SUPPLIED"
      : parseProvenanceSource(input.source);
  if (input.authority === "INTEGRATION" && source === "PARTICIPANT_SUPPLIED") {
    throw new DomainError(
      "INTEGRATION_TRUST_BOUNDARY",
      "Integration import cannot be marked participant-supplied",
      403,
    );
  }
  const provider = optionalText(input.provider, "provider");
  if (!provider) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "provider is required", 400);
  }
  const eventData = parseEventData(input.eventData);
  if (normalized.carrierStatus) {
    eventData.carrierStatus = normalized.carrierStatus;
  }
  return {
    transactionId: input.transactionId.trim(),
    eventType: normalized.eventType,
    occurredAt: parseOccurredAt(input.occurredAt),
    carrier: optionalText(input.carrier, "carrier"),
    locationText: optionalText(input.locationText, "locationText"),
    source,
    provider,
    sourceEventId: optionalText(input.sourceEventId, "sourceEventId"),
    eventData,
    payloadSha256: parseOptionalSha256(input.payloadSha256),
    authority: input.authority,
  };
}

function parseOccurredAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "occurredAt is required", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "occurredAt must be an ISO timestamp", 400);
  }
  return parsed.toISOString();
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_SHIPMENT_EVENT", `${field} must be a string`, 400);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseOptionalSha256(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "payloadSha256 must be a SHA-256 hex digest", 400);
  }
  return value;
}

function parseEventData(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return parseEventData(JSON.parse(value) as unknown);
    } catch {
      throw new DomainError("INVALID_SHIPMENT_EVENT", "eventData must be a JSON object", 400);
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "eventData must be a JSON object", 400);
  }
  const record = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_EVENT_DATA_KEYS.includes(key.toLowerCase())) {
      throw new DomainError(
        "INVALID_SHIPMENT_EVENT",
        "eventData must not include credentials or secret-bearing fields",
        400,
      );
    }
  }
  const encoded = JSON.stringify(record);
  if (encoded.length > EVENT_DATA_MAX_BYTES) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "eventData is too large", 400);
  }
  return record;
}

function parseProvenanceSource(value: unknown): ProvenanceSource {
  if (!isProvenanceSource(value)) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "source must be a known provenance source", 400);
  }
  return value;
}

async function assertCanRecord(
  db: Database,
  actorUserId: string,
  bundle: TransactionBundle,
  authority: "INTEGRATION" | "PARTICIPANT",
): Promise<void> {
  if (authority === "INTEGRATION") {
    if (bundle.txn.created_by !== actorUserId) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "Only the seller can import shipment observations",
        403,
      );
    }
    return;
  }
  if (!bundle.proofId) {
    throw new DomainError(
      "SHIPMENT_EVENT_PROOF_REQUIRED",
      "A Proof must exist before shipment observations can be recorded",
      422,
    );
  }
  const participant = await db.query<{ id: string }>(
    `SELECT id FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
    [bundle.proofId, actorUserId],
  );
  if (!participant.rows[0]) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Not allowed to record a shipment observation on this transaction",
      403,
    );
  }
}

async function ensureShippingIdentity(
  db: Database,
  bundle: TransactionBundle,
  carrier: string | null,
  nowIso: string,
): Promise<ShippingRow> {
  if (bundle.shipping) {
    return bundle.shipping;
  }
  if (bundle.proofStatus === "FINALIZED") {
    throw new DomainError(
      "SHIPMENT_IDENTITY_REQUIRED",
      "Shipment identity cannot be created after the core Proof is finalized",
      409,
    );
  }
  await insertShipping(
    db,
    bundle.txn.id,
    {
      carrier,
      service: null,
      trackingNumber: null,
      shipmentDate: null,
    },
    nowIso,
  );
  const shipping = await db.query<ShippingRow>(
    `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
    [bundle.txn.id],
  );
  const row = shipping.rows[0];
  if (!row) {
    throw new DomainError("SHIPMENT_IDENTITY_REQUIRED", "Shipment identity is missing", 422);
  }
  return row;
}

async function loadCoreManifestSha256(
  db: Database,
  proof: ProofRow | undefined,
): Promise<string | null> {
  if (!proof?.manifest_id) {
    return null;
  }
  const manifest = await db.query<ManifestRow>(
    `SELECT * FROM final_manifests WHERE proof_id = $1`,
    [proof.id],
  );
  return manifest.rows[0]?.sha256 ?? null;
}

async function findExistingEvent(
  db: Database,
  input: {
    provider: string;
    sourceEventId: string | null;
    transactionId: string;
    fingerprint: string;
  },
): Promise<ShipmentEventRow | null> {
  if (input.sourceEventId) {
    const bySource = await db.query<ShipmentEventRow>(
      `SELECT * FROM shipment_events WHERE provider = $1 AND source_event_id = $2`,
      [input.provider, input.sourceEventId],
    );
    if (bySource.rows[0]) {
      return bySource.rows[0];
    }
  }
  const byFingerprint = await db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events
      WHERE transaction_id = $1 AND dedupe_fingerprint = $2`,
    [input.transactionId, input.fingerprint],
  );
  return byFingerprint.rows[0] ?? null;
}

function assertSameEventIdentity(
  existing: ShipmentEventRow,
  proofId: string,
  transactionId: string,
  contentSha256: string,
): void {
  if (existing.proof_id !== proofId || existing.transaction_id !== transactionId) {
    throw new DomainError(
      "SHIPMENT_EVENT_CONFLICT",
      "Provider event identity is already bound to another transaction or Proof",
      409,
    );
  }
  if (existing.content_sha256 !== contentSha256) {
    throw new DomainError(
      "SHIPMENT_EVENT_CONFLICT",
      "Provider event identity conflicts with an existing observation",
      409,
    );
  }
}

function toView(row: ShipmentEventRow): ShipmentEventView {
  return {
    id: row.id,
    proofId: row.proof_id,
    transactionId: row.transaction_id,
    shippingId: row.shipping_id,
    eventType: row.event_type,
    occurredAt: asRequiredIso(row.occurred_at),
    observedAt: asRequiredIso(row.observed_at),
    source: row.source,
    provider: row.provider,
    carrier: row.carrier,
    location: row.location_text,
    eventData: asEventData(row.event_data),
    sha256: row.sha256,
    contentSha256: row.content_sha256,
    previousEventSha256: row.previous_event_sha256,
    coreManifestSha256: row.core_manifest_sha256,
    payloadSha256: row.payload_sha256,
    sourceEventId: row.source_event_id,
  };
}
