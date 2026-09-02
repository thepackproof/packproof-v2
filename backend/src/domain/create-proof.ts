import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { ensureTransactionExternalReference } from "./external-references.js";
import {
  ensureImportAuditEvents,
  ensureIntegrationExternalReferences,
} from "./integration-identities.js";
import { getProofView, loadProof, type ProofView } from "./proofs.js";
import type { ProofRow, TransactionRow } from "./types.js";
import {
  DEFAULT_PARTICIPATION_POLICY,
  requireParticipationPolicy,
  type ParticipationPolicy,
} from "./participation.js";
import { createProofAssets } from "./assets.js";
import { createTransaction } from "./transactions.js";
import { DEFAULT_WORKFLOW_TYPE, requireWorkflowType, type WorkflowType } from "./workflow.js";

export async function createOrGetProof(
  db: Database,
  clock: Clock,
  actorUserId: string,
  transactionId: string,
  options: {
    participationPolicy?: ParticipationPolicy;
    workflowType?: WorkflowType;
    assetCount?: number;
  } = {},
): Promise<ProofView> {
  return db.transaction(async (tx) => {
    const transaction = await tx.query<TransactionRow>(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    const txn = transaction.rows[0];
    if (!txn) {
      throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
    }
    if (txn.created_by !== actorUserId) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "Only the transaction creator can create the Proof",
        403,
      );
    }

    const existing = await tx.query<ProofRow>(
      `SELECT * FROM proofs WHERE transaction_id = $1`,
      [transactionId],
    );
    if (existing.rows[0]) {
      await requireExistingSeller(tx, existing.rows[0].id, actorUserId);
      await ensureTransactionExternalReference(
        tx,
        clock,
        actorUserId,
        existing.rows[0].id,
        txn.external_reference,
      );
      await ensureIntegrationExternalReferences(
        tx,
        clock,
        actorUserId,
        existing.rows[0].id,
        transactionId,
      );
      await ensureImportAuditEvents(tx, clock, actorUserId, existing.rows[0].id, transactionId);
      return getProofView(tx, existing.rows[0].id);
    }

    const proofId = newId("proof");
    const now = clock.now().toISOString();
    const participationPolicy = requireParticipationPolicy(
      options.participationPolicy,
      DEFAULT_PARTICIPATION_POLICY,
    );
    const workflowType = requireWorkflowType(options.workflowType, DEFAULT_WORKFLOW_TYPE);
    // Optional-counterparty Proofs skip AWAITING_PARTICIPANT. REQUIRED proofs
    // still start OPEN and move to AWAITING_PARTICIPANT on invite.
    const initialStatus =
      participationPolicy === "COUNTERPARTY_OPTIONAL" ? "READY_FOR_EVIDENCE" : "OPEN";
    try {
      await tx.query(
        `INSERT INTO proofs (
           id, transaction_id, status, participation_policy, workflow_type, created_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, 1)`,
        [proofId, transactionId, initialStatus, participationPolicy, workflowType, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await tx.query<ProofRow>(
          `SELECT * FROM proofs WHERE transaction_id = $1`,
          [transactionId],
        );
        if (!raced.rows[0]) {
          throw error;
        }
        await requireExistingSeller(tx, raced.rows[0].id, actorUserId);
        await ensureTransactionExternalReference(
          tx,
          clock,
          actorUserId,
          raced.rows[0].id,
          txn.external_reference,
        );
        await ensureIntegrationExternalReferences(
          tx,
          clock,
          actorUserId,
          raced.rows[0].id,
          transactionId,
        );
        await ensureImportAuditEvents(tx, clock, actorUserId, raced.rows[0].id, transactionId);
        return getProofView(tx, raced.rows[0].id);
      }
      throw error;
    }

    await tx.query(
      `INSERT INTO proof_participants (id, proof_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, 'SELLER', $4)`,
      [newId("prt"), proofId, actorUserId, now],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_CREATED",
      eventData: { transactionId, workflowType },
      at: clock.now(),
    });
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PARTICIPANT_JOINED",
      eventData: { role: "SELLER", userId: actorUserId },
      at: clock.now(),
    });

    await ensureTransactionExternalReference(
      tx,
      clock,
      actorUserId,
      proofId,
      txn.external_reference,
    );
    await ensureIntegrationExternalReferences(tx, clock, actorUserId, proofId, transactionId);
    await ensureImportAuditEvents(tx, clock, actorUserId, proofId, transactionId);
    if (workflowType === "GRADING_SUBMISSION") {
      await createProofAssets(tx, clock, actorUserId, proofId, {
        count: options.assetCount ?? 1,
      });
    }
    return getProofView(tx, proofId, actorUserId);
  });
}

export async function createProof(
  db: Database,
  clock: Clock,
  actorUserId: string,
  input: {
    workflowType?: unknown;
    itemCount?: unknown;
    participationPolicy?: ParticipationPolicy;
    transaction?: unknown;
  } = {},
): Promise<ProofView> {
  const workflowType = requireWorkflowType(input.workflowType);
  const itemCount =
    input.itemCount == null || input.itemCount === "" ? (workflowType === "GRADING_SUBMISSION" ? 1 : 0) : Number(input.itemCount);
  const transactionInput =
    input.transaction && typeof input.transaction === "object"
      ? (input.transaction as Record<string, unknown>)
      : {};
  if (workflowType === "GRADING_SUBMISSION" && !transactionInput.itemTitle) {
    transactionInput.itemTitle = "Grading submission";
  }
  const transaction = await createTransaction(db, clock, actorUserId, transactionInput);
  return createOrGetProof(db, clock, actorUserId, transaction.transactionId, {
    participationPolicy: input.participationPolicy,
    workflowType,
    assetCount: workflowType === "GRADING_SUBMISSION" ? itemCount : undefined,
  });
}

async function requireExistingSeller(
  db: Database,
  proofId: string,
  actorUserId: string,
): Promise<void> {
  const proof = await loadProof(db, proofId);
  const seller = await db.query<{ user_id: string }>(
    `SELECT user_id FROM proof_participants WHERE proof_id = $1 AND role = 'SELLER'`,
    [proofId],
  );
  if (seller.rows[0]?.user_id !== actorUserId && proof.status !== "FINALIZED") {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Only the seller can create or fetch the Proof from the transaction",
      403,
    );
  }
  if (seller.rows[0]?.user_id !== actorUserId) {
    const member = await db.query(
      `SELECT 1 FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
      [proofId, actorUserId],
    );
    if (!member.rows[0]) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "Not a participant of this Proof",
        403,
      );
    }
  }
}
