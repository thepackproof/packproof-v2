import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { appendAudit, listAuditIds } from "./audit.js";
import { DomainError } from "./errors.js";
import {
  assertNotFinalized,
  getProofView,
  loadProof,
  requireParticipant,
  type ProofView,
} from "./proofs.js";
import {
  asRequiredIso,
  type EvidenceRow,
  type ManifestRow,
  type ParticipantRow,
  type ProofRow,
  type ShippingRow,
  type TransactionRow,
} from "./types.js";
import { asNullableNumber, shippingForManifest } from "./transaction-fields.js";

export interface ManifestView {
  manifestId: string;
  proofId: string;
  sha256: string;
  manifest: unknown;
  canonicalJson: string;
}

export interface FinalizeView {
  proof: ProofView;
  manifest: ManifestView;
}

export async function getManifest(
  db: Database,
  actorUserId: string,
  proofId: string,
): Promise<ManifestView> {
  await requireParticipant(db, proofId, actorUserId);
  const found = await db.query<ManifestRow>(
    `SELECT * FROM final_manifests WHERE proof_id = $1`,
    [proofId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new DomainError("MANIFEST_NOT_FOUND", "Proof has not been finalized", 404);
  }
  return {
    manifestId: row.id,
    proofId: row.proof_id,
    sha256: row.sha256,
    canonicalJson: row.canonical_json,
    manifest: JSON.parse(row.canonical_json) as unknown,
  };
}

export async function finalizeProof(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
): Promise<FinalizeView> {
  return db.transaction(async (tx) => {
    const existingProof = await tx.query<ProofRow>(`SELECT * FROM proofs WHERE id = $1`, [proofId]);
    if (!existingProof.rows[0]) {
      throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
    }
    await tx.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [
      existingProof.rows[0].transaction_id,
    ]);
    await tx.query(`SELECT id FROM transaction_shipping WHERE transaction_id = $1 FOR UPDATE`, [
      existingProof.rows[0].transaction_id,
    ]);
    const proof = await loadProof(tx, proofId, true);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");

    const existing = await tx.query<ManifestRow>(
      `SELECT * FROM final_manifests WHERE proof_id = $1`,
      [proofId],
    );
    if (proof.status === "FINALIZED" || existing.rows[0]) {
      if (!existing.rows[0]) {
        throw new DomainError(
          "PROOF_ALREADY_FINALIZED",
          "Proof is finalized but manifest is missing",
          500,
        );
      }
      return {
        proof: await getProofView(tx, proofId),
        manifest: {
          manifestId: existing.rows[0].id,
          proofId,
          sha256: existing.rows[0].sha256,
          canonicalJson: existing.rows[0].canonical_json,
          manifest: JSON.parse(existing.rows[0].canonical_json) as unknown,
        },
      };
    }

    assertNotFinalized(proof);
    if (proof.status !== "EVIDENCE_COMMITTED") {
      throw new DomainError(
        "PROOF_NOT_READY_FOR_FINALIZATION",
        "Required evidence is not committed",
        422,
      );
    }

    const participants = await tx.query<ParticipantRow>(
      `SELECT * FROM proof_participants WHERE proof_id = $1`,
      [proofId],
    );
    const hasSeller = participants.rows.some((row) => row.role === "SELLER");
    const hasBuyer = participants.rows.some((row) => row.role === "BUYER");
    if (!hasSeller || !hasBuyer) {
      throw new DomainError(
        "PROOF_NOT_READY_FOR_FINALIZATION",
        "Seller and buyer must both be joined",
        422,
      );
    }

    const evidence = await tx.query<EvidenceRow>(
      `SELECT * FROM evidence
        WHERE proof_id = $1 AND validation_status = 'COMMITTED'
        ORDER BY committed_at ASC, id ASC`,
      [proofId],
    );
    if (evidence.rows.length === 0) {
      throw new DomainError(
        "PROOF_NOT_READY_FOR_FINALIZATION",
        "Required evidence is not committed",
        422,
      );
    }

    const transaction = await tx.query<TransactionRow>(
      `SELECT * FROM transactions WHERE id = $1`,
      [proof.transaction_id],
    );
    const txn = transaction.rows[0];
    if (!txn) {
      throw new DomainError("TRANSACTION_NOT_FOUND", "Transaction not found", 404);
    }
    const shipping = await tx.query<ShippingRow>(
      `SELECT * FROM transaction_shipping WHERE transaction_id = $1`,
      [proof.transaction_id],
    );
    const ship = shippingForManifest(shipping.rows[0]);

    const now = clock.now();
    const auditEventIds = await listAuditIds(tx, proofId);
    const manifestId = newId("man");
    const payload = {
      manifestVersion: 1,
      proofId,
      transactionId: proof.transaction_id,
      transaction: {
        transactionId: proof.transaction_id,
        externalReference: txn.external_reference,
        transactionDate: txn.transaction_date,
        itemTitle: txn.item_title,
        itemDescription: txn.item_description,
        quantity: asNullableNumber(txn.quantity),
        transactionValue: asNullableNumber(txn.transaction_value),
        currency: txn.currency,
        metadata: txn.transaction_metadata ?? {},
      },
      shipping: {
        carrier: ship.carrier,
        service: ship.service,
        trackingNumber: ship.trackingNumber,
        shipmentDate: ship.shipmentDate,
      },
      participants: participants.rows
        .map((row) => ({
          participantId: row.id,
          userId: row.user_id,
          role: row.role,
          joinedAt: asRequiredIso(row.joined_at),
        }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId)),
      evidence: evidence.rows.map((row) => ({
        evidenceId: row.id,
        evidenceType: row.evidence_type,
        objectKey: row.object_key,
        contentType: row.content_type,
        byteSize: Number(row.byte_size ?? 0),
        sha256: row.sha256,
        submittedBy: row.submitted_by,
        committedAt: asRequiredIso(row.committed_at as Date | string),
      })),
      auditEventIds,
      createdAt: asRequiredIso(proof.created_at),
      finalizedAt: now.toISOString(),
    };

    const canonicalJson = canonicalize(payload);
    const digest = sha256Hex(canonicalJson);

    await tx.query(
      `INSERT INTO final_manifests (id, proof_id, canonical_json, sha256, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [manifestId, proofId, canonicalJson, digest, now.toISOString()],
    );
    await tx.query(
      `UPDATE proofs
          SET status = 'FINALIZED',
              finalized_at = $2,
              manifest_id = $3,
              updated_at = $2
        WHERE id = $1`,
      [proofId, now.toISOString(), manifestId],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_FINALIZED",
      eventData: { manifestId, sha256: digest },
      at: now,
    });

    return {
      proof: await getProofView(tx, proofId),
      manifest: {
        manifestId,
        proofId,
        sha256: digest,
        canonicalJson,
        manifest: JSON.parse(canonicalJson) as unknown,
      },
    };
  });
}

export function hashCanonicalManifest(manifest: unknown): { canonicalJson: string; sha256: string } {
  const canonicalJson = canonicalize(manifest);
  return { canonicalJson, sha256: sha256Hex(canonicalJson) };
}
