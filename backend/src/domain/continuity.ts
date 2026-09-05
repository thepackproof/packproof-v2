import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso } from "./types.js";
import { listObservations, type ObservationView } from "./observations.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";
import {
  continuitySummary,
  requireContinuityResult,
  type ContinuityResult,
} from "./workflow.js";

export const CONTINUITY_ALGORITHM_V1 = "visual-slot-completeness/v1";
export const CONTINUITY_ALGORITHM_V2 = "visual-slot-completeness/v2";

export interface ContinuityEvaluationRow {
  id: string;
  proof_id: string;
  from_observation_id: string;
  to_observation_id: string;
  algorithm_version: string;
  result: ContinuityResult | string;
  summary: string;
  evidence_pairs: unknown;
  actor_participant_id: string | null;
  idempotency_key: string | null;
  created_at: Date | string;
}

export interface ContinuityView {
  evaluationId: string;
  proofId: string;
  fromObservationId: string;
  toObservationId: string;
  algorithmVersion: string;
  result: ContinuityResult | string;
  summary: string;
  actorParticipantId: string | null;
  evidencePairs: Array<{
    slot: string;
    originEvidenceId: string | null;
    receivedEvidenceId: string | null;
  }>;
  createdAt: string;
}

export function toContinuityView(row: ContinuityEvaluationRow): ContinuityView {
  const legacyCompleteness = row.algorithm_version === CONTINUITY_ALGORITHM_V1 && row.result === "CONSISTENT";
  return {
    evaluationId: row.id,
    proofId: row.proof_id,
    fromObservationId: row.from_observation_id,
    toObservationId: row.to_observation_id,
    algorithmVersion: row.algorithm_version,
    result: legacyCompleteness ? "INCONCLUSIVE" : row.result,
    summary: legacyCompleteness
      ? "Legacy capture availability check; visual consistency was not evaluated."
      : row.summary,
    actorParticipantId: row.actor_participant_id,
    evidencePairs: asPairs(row.evidence_pairs),
    createdAt: asRequiredIso(row.created_at),
  };
}

export async function listContinuityEvaluations(
  db: Database,
  proofId: string,
): Promise<ContinuityView[]> {
  const found = await db.query<ContinuityEvaluationRow>(
    `SELECT * FROM continuity_evaluations
      WHERE proof_id = $1
      ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toContinuityView);
}

export async function evaluateContinuity(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    fromObservationId?: string | null;
    toObservationId?: string | null;
    finding?: unknown;
    idempotencyKey?: string | null;
    algorithmVersion?: string;
  } = {},
): Promise<ContinuityView> {
  const finding = input.finding == null || input.finding === ""
    ? null
    : requireContinuityResult(input.finding);
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    const participant = await requireParticipant(tx, proofId, actorUserId);
    // Provenance is server-owned. A participant cannot label a manual finding
    // with the automatic algorithm name, or request the unsafe legacy default.
    const algorithmVersion = finding
      ? `participant-recorded/v1/${participant.id}/${finding}`
      : CONTINUITY_ALGORITHM_V2;
    if (idempotencyKey) {
      const existing = await tx.query<ContinuityEvaluationRow>(
        `SELECT * FROM continuity_evaluations WHERE proof_id = $1 AND idempotency_key = $2`,
        [proofId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.actor_participant_id !== participant.id ||
          (finding && row.result !== finding) ||
          (input.fromObservationId && row.from_observation_id !== input.fromObservationId) ||
          (input.toObservationId && row.to_observation_id !== input.toObservationId) ||
          row.algorithm_version !== algorithmVersion) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "This comparison key already identifies a different request",
            409,
          );
        }
        return toContinuityView(existing.rows[0]);
      }
    }

    const observations = await listObservations(tx, proofId);
    const from =
      resolveObservation(observations, input.fromObservationId, ["ORIGIN_CAPTURE"]) ??
      [...observations].reverse().find((row) => row.type === "ORIGIN_CAPTURE");
    const to =
      resolveObservation(observations, input.toObservationId, ["INTAKE_CAPTURE", "RECEIVED"]) ??
      [...observations].reverse().find((row) => row.type === "INTAKE_CAPTURE") ??
      [...observations].reverse().find((row) => row.type === "RECEIVED");
    if (!from || !to) {
      throw new DomainError(
        "CONTINUITY_NOT_READY",
        "Origin and receiving observations are required before comparison",
        422,
      );
    }

    const existingVersion = await tx.query<ContinuityEvaluationRow>(
      `SELECT * FROM continuity_evaluations
        WHERE proof_id = $1
          AND from_observation_id = $2
          AND to_observation_id = $3
          AND algorithm_version = $4`,
      [proofId, from.observationId, to.observationId, algorithmVersion],
    );
    if (existingVersion.rows[0]) {
      if (finding && (existingVersion.rows[0].result !== finding ||
        existingVersion.rows[0].actor_participant_id !== participant.id)) {
        throw new DomainError(
          "CONTINUITY_FINDING_CONFLICT",
          "This comparison version already records a different participant finding",
          409,
        );
      }
      return toContinuityView(existingVersion.rows[0]);
    }

    const pairs = pairEvidence(from, to);
    const derived = deriveResult(pairs);
    const result = finding ?? derived;
    const summary = finding
      ? `Participant-recorded finding: ${continuitySummary(result)}`
      : "Capture availability was checked; visual consistency has not been evaluated.";
    const id = newId("cev");
    const now = clock.now();
    try {
      await tx.query(
        `INSERT INTO continuity_evaluations (
           id, proof_id, from_observation_id, to_observation_id, algorithm_version,
           result, summary, evidence_pairs, actor_participant_id, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          id,
          proofId,
          from.observationId,
          to.observationId,
          algorithmVersion,
          result,
          summary,
          JSON.stringify(pairs),
          participant.id,
          idempotencyKey,
          now.toISOString(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await tx.query<ContinuityEvaluationRow>(
          `SELECT * FROM continuity_evaluations
            WHERE proof_id = $1
              AND from_observation_id = $2
              AND to_observation_id = $3
              AND algorithm_version = $4`,
          [proofId, from.observationId, to.observationId, algorithmVersion],
        );
        if (raced.rows[0]) {
          return toContinuityView(raced.rows[0]);
        }
      }
      throw error;
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "CONTINUITY_EVALUATED",
      eventData: {
        evaluationId: id,
        fromObservationId: from.observationId,
        toObservationId: to.observationId,
        algorithmVersion,
        result,
      },
      at: now,
    });
    if (result === "MATERIAL_DIFFERENCE") {
      await appendAudit(tx, {
        proofId,
        actorUserId,
        eventType: "MATERIAL_DIFFERENCE_RECORDED",
        eventData: { evaluationId: id, summary },
        at: now,
      });
    }
    return toContinuityView({
      id,
      proof_id: proofId,
      from_observation_id: from.observationId,
      to_observation_id: to.observationId,
      algorithm_version: algorithmVersion,
      result,
      summary,
      evidence_pairs: pairs,
      actor_participant_id: participant.id,
      idempotency_key: idempotencyKey,
      created_at: now.toISOString(),
    });
  });
}

function resolveObservation(
  observations: ObservationView[],
  id: string | null | undefined,
  types: string[],
): ObservationView | undefined {
  if (!id) {
    return undefined;
  }
  const found = observations.find((row) => row.observationId === id);
  if (!found) {
    throw new DomainError("OBSERVATION_NOT_FOUND", "Observation not found", 404);
  }
  if (!types.includes(found.type)) {
    throw new DomainError("INVALID_OBSERVATION_TYPE", "Observation cannot be used for this comparison", 422);
  }
  return found;
}

function pairEvidence(
  from: ObservationView,
  to: ObservationView,
): Array<{ slot: string; originEvidenceId: string | null; receivedEvidenceId: string | null }> {
  const origin = new Map(from.evidence.map((row) => [normalizeSlot(row.slot), row.evidenceId]));
  const received = new Map(to.evidence.map((row) => [normalizeSlot(row.slot), row.evidenceId]));
  const slots = new Set([...origin.keys(), ...received.keys()]);
  if (slots.size === 0) {
    slots.add("FRONT");
    slots.add("BACK");
  }
  return [...slots].sort().map((slot) => ({
    slot,
    originEvidenceId: origin.get(slot) ?? origin.get(slot.replace("ITEM_", "")) ?? null,
    receivedEvidenceId: received.get(slot) ?? received.get(`ITEM_${slot}`) ?? null,
  }));
}

function normalizeSlot(slot: string): string {
  if (slot === "ITEM_FRONT") {
    return "FRONT";
  }
  if (slot === "ITEM_BACK") {
    return "BACK";
  }
  return slot;
}

function deriveResult(
  pairs: Array<{ originEvidenceId: string | null; receivedEvidenceId: string | null }>,
): ContinuityResult {
  if (pairs.length === 0) {
    return "NOT_EVALUATED";
  }
  // Matching capture slots establishes availability, not visual agreement.
  // Only an explicit participant finding may assert consistency or a difference.
  return "INCONCLUSIVE";
}

function asPairs(value: unknown): ContinuityView["evidencePairs"] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      try {
        return asPairs(JSON.parse(value) as unknown);
      } catch {
        return [];
      }
    }
    return [];
  }
  return value.map((row) => {
    const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      slot: String(record.slot ?? ""),
      originEvidenceId: typeof record.originEvidenceId === "string" ? record.originEvidenceId : null,
      receivedEvidenceId:
        typeof record.receivedEvidenceId === "string" ? record.receivedEvidenceId : null,
    };
  });
}
