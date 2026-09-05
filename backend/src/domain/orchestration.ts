import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { listProofAssets } from "./assets.js";
import { assertRecipeEvidence, requireCaptureRecipe } from "./capture-recipes.js";
import { evaluateContinuity } from "./continuity.js";
import { DomainError } from "./errors.js";
import { createObservation, latestObservationOfType, listObservations } from "./observations.js";
import { getProofView, loadProof, type ProofView } from "./proofs.js";
import { requireParticipant } from "./proof-access.js";
import { closeTransfer, listTransfers, openTransfer } from "./transfers.js";
import { updateShipping } from "./transactions.js";
import { requireTransferType } from "./workflow.js";

export interface OrchestrationResult {
  proof: ProofView;
}

function idempotencyOf(input: { idempotencyKey?: unknown }): string | null {
  return typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : null;
}

export async function documentAssets(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    assetId?: string;
    assetIds?: string[];
    recipe?: unknown;
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  },
): Promise<OrchestrationResult> {
  const recipe = requireCaptureRecipe(input.recipe ?? "CARD_STANDARD_V1");
  const evidence = input.evidence ?? [];
  assertRecipeEvidence(recipe, evidence);
  await requireParticipant(db, proofId, actorUserId);
  const assets = await listProofAssets(db, proofId);
  const assetIds = unique([
    ...(input.assetId ? [input.assetId] : []),
    ...(input.assetIds ?? []),
  ]);
  if (assetIds.length === 0) {
    const first = assets[0];
    if (!first) {
      throw new DomainError("ASSET_NOT_FOUND", "Add an item before documenting it", 422);
    }
    assetIds.push(first.assetId);
  }
  const participant = await requireParticipant(db, proofId, actorUserId);
  const type = participant.role === "BUYER" ? "INTAKE_CAPTURE" : "ORIGIN_CAPTURE";
  await createObservation(db, clock, actorUserId, proofId, {
    type,
    assetIds,
    evidence,
    occurredAt: input.occurredAt,
    captureRecipe: recipe.id,
    idempotencyKey: idempotencyOf(input),
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

export async function completePacking(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    assetIds?: string[];
    recipe?: unknown;
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  const recipe = requireCaptureRecipe(input.recipe ?? "PACKING_STANDARD_V1");
  if (input.evidence && input.evidence.length > 0) {
    assertRecipeEvidence(recipe, input.evidence);
  }
  const assets = await listProofAssets(db, proofId);
  const assetIds = unique(input.assetIds ?? assets.map((asset) => asset.assetId));
  await createObservation(db, clock, actorUserId, proofId, {
    type: "PACKED",
    assetIds,
    evidence: input.evidence ?? [],
    occurredAt: input.occurredAt,
    captureRecipe: recipe.id,
    idempotencyKey: idempotencyOf(input),
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

export async function handoffAssets(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    transferType?: unknown;
    shipping?: {
      carrier?: string | null;
      service?: string | null;
      trackingNumber?: string | null;
      shipmentDate?: string | null;
    } | null;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  return db.transaction(async (tx) => {
    const packed = await latestObservationOfType(tx, proofId, "PACKED");
    if (!packed) {
      throw new DomainError("OBSERVATION_NOT_FOUND", "Pack items before handing them off", 422);
    }
    // Follow the transaction -> shipping -> Proof lock order used by finalization.
    // Recording RELEASED first would hold the Proof while waiting for shipping,
    // which can deadlock with a concurrent finalization or context update.
    const loaded = await loadProof(tx, proofId);
    if (input.shipping) {
      await updateShipping(tx, clock, actorUserId, loaded.transaction_id, input.shipping);
    }
    const key = idempotencyOf(input);
    const released = await createObservation(tx, clock, actorUserId, proofId, {
      type: "RELEASED",
      assetIds: packed.assetIds,
      previousObservationId: packed.observationId,
      occurredAt: input.occurredAt,
      idempotencyKey: key ? `${key}:released` : null,
    });
    await openTransfer(tx, clock, actorUserId, proofId, {
      fromObservationId: released.observationId,
      transferType: requireTransferType(input.transferType),
      carrierContext: input.shipping ?? {},
      idempotencyKey: key ? `${key}:transfer` : key,
    });
    return { proof: await getProofView(tx, proofId, actorUserId) };
  });
}

export async function receiveAssets(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    transferId?: string;
    assetIds?: string[];
    recipe?: unknown;
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  return db.transaction(async (tx) => {
    const transfers = await listTransfers(tx, proofId);
    const transfer =
      (input.transferId
        ? transfers.find((row) => row.transferId === input.transferId)
        : transfers.find((row) => row.status === "OPEN")) ?? null;
    if (!transfer) {
      throw new DomainError("TRANSFER_NOT_FOUND", "No open handoff exists to receive", 404);
    }
    if (transfer.proofId !== proofId) {
      throw new DomainError("TRANSFER_PROOF_MISMATCH", "Transfer does not belong to this Proof", 409);
    }
    const recipe = input.evidence?.length
      ? requireCaptureRecipe(input.recipe ?? "RECEIPT_STANDARD_V1")
      : null;
    if (recipe && input.evidence) {
      assertRecipeEvidence(recipe, input.evidence);
    }
    const from = (await listObservations(tx, proofId)).find(
      (row) => row.observationId === transfer.fromObservationId,
    );
    const key = idempotencyOf(input);
    const received = await createObservation(tx, clock, actorUserId, proofId, {
      type: "RECEIVED",
      assetIds: input.assetIds ?? from?.assetIds ?? [],
      evidence: input.evidence ?? [],
      previousObservationId: transfer.fromObservationId,
      occurredAt: input.occurredAt,
      captureRecipe: recipe?.id ?? null,
      idempotencyKey: key ? `${key}:received` : null,
    });
    await closeTransfer(tx, clock, actorUserId, proofId, {
      transferId: transfer.transferId,
      toObservationId: received.observationId,
    });
    if (input.evidence && input.evidence.length > 0) {
      await createObservation(tx, clock, actorUserId, proofId, {
        type: "INTAKE_CAPTURE",
        assetIds: received.assetIds,
        evidence: input.evidence,
        previousObservationId: received.observationId,
        occurredAt: input.occurredAt,
        captureRecipe: recipe?.id ?? "RECEIPT_STANDARD_V1",
        idempotencyKey: key ? `${key}:intake` : null,
      });
    }
    return { proof: await getProofView(tx, proofId, actorUserId) };
  });
}

export async function documentProcessingOutput(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    assetIds?: string[];
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  const assets = await listProofAssets(db, proofId);
  await createObservation(db, clock, actorUserId, proofId, {
    type: "PROCESS_OUTPUT",
    assetIds: input.assetIds ?? assets.map((asset) => asset.assetId),
    evidence: input.evidence ?? [],
    occurredAt: input.occurredAt,
    idempotencyKey: idempotencyOf(input),
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

export async function completeReturnPacking(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    assetIds?: string[];
    recipe?: unknown;
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  const recipe = requireCaptureRecipe(input.recipe ?? "PACKING_STANDARD_V1");
  if (input.evidence && input.evidence.length > 0) {
    assertRecipeEvidence(recipe, input.evidence);
  }
  const assets = await listProofAssets(db, proofId);
  await createObservation(db, clock, actorUserId, proofId, {
    type: "RETURN_PACKED",
    assetIds: input.assetIds ?? assets.map((asset) => asset.assetId),
    evidence: input.evidence ?? [],
    occurredAt: input.occurredAt,
    captureRecipe: recipe.id,
    idempotencyKey: idempotencyOf(input),
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

export async function completeFinalReceipt(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    assetIds?: string[];
    evidence?: Array<{ evidenceId: string; slot: string }>;
    occurredAt?: unknown;
    idempotencyKey?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  const assets = await listProofAssets(db, proofId);
  await createObservation(db, clock, actorUserId, proofId, {
    type: "FINAL_RECEIPT",
    assetIds: input.assetIds ?? assets.map((asset) => asset.assetId),
    evidence: input.evidence ?? [],
    occurredAt: input.occurredAt,
    idempotencyKey: idempotencyOf(input),
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

export async function compareObservations(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    fromObservationId?: string;
    toObservationId?: string;
    finding?: unknown;
    idempotencyKey?: unknown;
    algorithmVersion?: unknown;
  } = {},
): Promise<OrchestrationResult> {
  await evaluateContinuity(db, clock, actorUserId, proofId, {
    fromObservationId: input.fromObservationId,
    toObservationId: input.toObservationId,
    finding: input.finding,
    idempotencyKey: idempotencyOf(input),
    algorithmVersion: typeof input.algorithmVersion === "string" ? input.algorithmVersion : undefined,
  });
  return { proof: await getProofView(db, proofId, actorUserId) };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
