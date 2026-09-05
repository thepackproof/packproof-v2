import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso, type EvidenceRow } from "./types.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";
import { requireCaptureRecipe } from "./capture-recipes.js";
import {
  observationAllowedForRole,
  requireObservationType,
  type ObservationType,
} from "./workflow.js";

export interface CustodyObservationRow {
  id: string;
  proof_id: string;
  observation_type: ObservationType | string;
  actor_participant_id: string | null;
  external_actor: string | null;
  occurred_at: Date | string;
  server_recorded_at: Date | string;
  previous_observation_id: string | null;
  capture_recipe: string | null;
  idempotency_key: string | null;
}

export interface ObservationView {
  observationId: string;
  proofId: string;
  type: string;
  label: string;
  actorParticipantId: string | null;
  externalActor: string | null;
  occurredAt: string;
  serverRecordedAt: string;
  previousObservationId: string | null;
  captureRecipe: string | null;
  assetIds: string[];
  evidence: Array<{ evidenceId: string; slot: string }>;
}

export function originDocumentedAssetIds(observations: ObservationView[]): Set<string> {
  return new Set(observations
    .filter((row) => {
      if (row.type !== "ORIGIN_CAPTURE") return false;
      try {
        const recipe = requireCaptureRecipe(row.captureRecipe ?? "CARD_STANDARD_V1");
        return recipe.evidenceType === "ASSET_CAPTURE" && recipe.slots
          .filter((slot) => slot.required)
          .every((slot) => row.evidence.some((link) => link.slot === slot.slot));
      } catch {
        return false;
      }
    })
    .flatMap((row) => row.assetIds));
}

export async function listObservations(db: Database, proofId: string): Promise<ObservationView[]> {
  const found = await db.query<CustodyObservationRow>(
    `SELECT * FROM custody_observations
      WHERE proof_id = $1
      ORDER BY occurred_at ASC, server_recorded_at ASC, id ASC`,
    [proofId],
  );
  if (found.rows.length === 0) {
    return [];
  }
  const assets = await db.query<{ observation_id: string; asset_id: string }>(
    `SELECT oa.observation_id, oa.asset_id
       FROM observation_assets oa
       JOIN custody_observations o ON o.id = oa.observation_id
      WHERE o.proof_id = $1
      ORDER BY oa.asset_id ASC`,
    [proofId],
  );
  const evidence = await db.query<{ observation_id: string; evidence_id: string; slot: string }>(
    `SELECT oe.observation_id, oe.evidence_id, oe.slot
       FROM observation_evidence oe
       JOIN custody_observations o ON o.id = oe.observation_id
      WHERE o.proof_id = $1
      ORDER BY oe.slot ASC, oe.evidence_id ASC`,
    [proofId],
  );
  const assetsBy = group(assets.rows, (row) => row.observation_id);
  const evidenceBy = group(evidence.rows, (row) => row.observation_id);
  return found.rows.map((row) => ({
    observationId: row.id,
    proofId: row.proof_id,
    type: row.observation_type,
    label: humanObservation(row.observation_type),
    actorParticipantId: row.actor_participant_id,
    externalActor: row.external_actor,
    occurredAt: asRequiredIso(row.occurred_at),
    serverRecordedAt: asRequiredIso(row.server_recorded_at),
    previousObservationId: row.previous_observation_id,
    captureRecipe: row.capture_recipe,
    assetIds: (assetsBy.get(row.id) ?? []).map((item) => item.asset_id),
    evidence: (evidenceBy.get(row.id) ?? []).map((item) => ({
      evidenceId: item.evidence_id,
      slot: item.slot,
    })),
  }));
}

export async function createObservation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    type: unknown;
    assetIds?: string[];
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    previousObservationId?: string | null;
    captureRecipe?: string | null;
    idempotencyKey?: string | null;
    externalActor?: string | null;
  },
): Promise<ObservationView> {
  const type = requireObservationType(input.type);
  const idempotencyKey = normalizeIdempotency(input.idempotencyKey);
  const evidenceLinks = (input.evidence ?? []).map((row) => ({
    evidenceId: String(row.evidenceId ?? "").trim(),
    slot: String(row.slot ?? "").trim() || "DEFAULT",
  }));
  const assetIds = uniqueIds(input.assetIds ?? []);

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    const participant = await requireParticipant(tx, proofId, actorUserId);
    if (!observationAllowedForRole(type, participant.role)) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "This participant cannot record that observation",
        403,
      );
    }
    if (idempotencyKey) {
      const existing = await tx.query<CustodyObservationRow>(
        `SELECT * FROM custody_observations WHERE proof_id = $1 AND idempotency_key = $2`,
        [proofId, idempotencyKey],
      );
      if (existing.rows[0]) {
        return (await listObservations(tx, proofId)).find((row) => row.observationId === existing.rows[0].id)!;
      }
    }

    await assertAssetsOnProof(tx, proofId, assetIds);
    await assertEvidenceUsable(tx, proofId, actorUserId, evidenceLinks);

    if (input.previousObservationId) {
      const previous = await tx.query(
        `SELECT id FROM custody_observations WHERE id = $1 AND proof_id = $2`,
        [input.previousObservationId, proofId],
      );
      if (!previous.rows[0]) {
        throw new DomainError("OBSERVATION_NOT_FOUND", "Previous observation was not found", 404);
      }
    }

    const id = newId("obs");
    const now = clock.now();
    const occurredAt = parseOccurredAt(input.occurredAt, now);
    try {
      await tx.query(
        `INSERT INTO custody_observations (
           id, proof_id, observation_type, actor_participant_id, external_actor,
           occurred_at, server_recorded_at, previous_observation_id, capture_recipe,
           idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          proofId,
          type,
          participant.id,
          input.externalActor?.trim() || null,
          occurredAt.toISOString(),
          now.toISOString(),
          input.previousObservationId ?? null,
          input.captureRecipe ?? null,
          idempotencyKey,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error) && idempotencyKey) {
        const raced = await tx.query<CustodyObservationRow>(
          `SELECT * FROM custody_observations WHERE proof_id = $1 AND idempotency_key = $2`,
          [proofId, idempotencyKey],
        );
        if (raced.rows[0]) {
          return (await listObservations(tx, proofId)).find((row) => row.observationId === raced.rows[0].id)!;
        }
      }
      throw error;
    }

    for (const assetId of assetIds) {
      await tx.query(
        `INSERT INTO observation_assets (observation_id, asset_id) VALUES ($1, $2)`,
        [id, assetId],
      );
    }
    for (const link of evidenceLinks) {
      await tx.query(
        `INSERT INTO observation_evidence (observation_id, evidence_id, slot) VALUES ($1, $2, $3)`,
        [id, link.evidenceId, link.slot],
      );
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "OBSERVATION_CREATED",
      eventData: { observationId: id, type, assetIds, evidenceIds: evidenceLinks.map((row) => row.evidenceId) },
      at: now,
    });
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "OBSERVATION_COMMITTED",
      eventData: { observationId: id, type },
      at: now,
    });

    const views = await listObservations(tx, proofId);
    return views.find((row) => row.observationId === id)!;
  });
}

export async function latestObservationOfType(
  db: Database,
  proofId: string,
  type: ObservationType,
): Promise<ObservationView | null> {
  const all = await listObservations(db, proofId);
  return [...all].reverse().find((row) => row.type === type) ?? null;
}

async function assertAssetsOnProof(db: Database, proofId: string, assetIds: string[]): Promise<void> {
  for (const assetId of assetIds) {
    const found = await db.query<{ id: string }>(
      `SELECT id FROM proof_assets WHERE proof_id = $1 AND id = $2`,
      [proofId, assetId],
    );
    if (!found.rows[0]) {
      throw new DomainError("ASSET_NOT_FOUND", "Asset does not belong to this Proof", 404);
    }
  }
}

async function assertEvidenceUsable(
  db: Database,
  proofId: string,
  _actorUserId: string,
  links: Array<{ evidenceId: string; slot: string }>,
): Promise<void> {
  for (const link of links) {
    if (!link.evidenceId) {
      throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence not found", 404);
    }
    const found = await db.query<EvidenceRow>(
      `SELECT * FROM evidence WHERE id = $1`,
      [link.evidenceId],
    );
    const evidence = found.rows[0];
    if (!evidence) {
      throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence not found", 404);
    }
    if (evidence.proof_id !== proofId) {
      throw new DomainError(
        "EVIDENCE_PROOF_MISMATCH",
        "Evidence from one Proof cannot attach to another",
        409,
      );
    }
    if (evidence.validation_status !== "COMMITTED" || !evidence.sha256) {
      throw new DomainError(
        "EVIDENCE_NOT_COMMITTED",
        "Uncommitted evidence cannot attach to an observation",
        422,
      );
    }
  }
}

function parseOccurredAt(value: unknown, fallback: Date): Date {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_OCCURRED_AT", "occurredAt must be an ISO timestamp", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError("INVALID_OCCURRED_AT", "occurredAt must be an ISO timestamp", 400);
  }
  return parsed;
}

function normalizeIdempotency(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is invalid", 400);
  }
  const key = value.trim();
  return key ? key : null;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = map.get(id) ?? [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

function humanObservation(type: string): string {
  switch (type) {
    case "ORIGIN_CAPTURE":
      return "Documented";
    case "PACKED":
      return "Packed";
    case "RELEASED":
      return "Handed off";
    case "RECEIVED":
      return "Received";
    case "INTAKE_CAPTURE":
      return "Documented on receipt";
    case "PROCESS_OUTPUT":
      return "Processing documented";
    case "RETURN_PACKED":
      return "Return packed";
    case "FINAL_RECEIPT":
      return "Final receipt";
    default:
      return "Recorded";
  }
}
