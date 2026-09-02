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
  type AttestationRow,
  type EvidenceRow,
  type ManifestRow,
  type ParticipantRow,
  type ProofRow,
  type ShippingRow,
  type TransactionIntegrationIdentityRow,
  type TransactionRow,
} from "./types.js";
import { asNullableNumber, shippingForManifest } from "./transaction-fields.js";
import { provenanceFromIdentity, manifestProvenance } from "./provenance.js";
import { listTransactionItems } from "./transaction-items.js";
import { isQualifyingFulfillmentCapture } from "./evidence-types.js";
import { evaluateFinalizeRequirements } from "./finalize-requirements.js";
import { DEFAULT_PARTICIPATION_POLICY, requireParticipationPolicy } from "./participation.js";
import { listObservations } from "./observations.js";
import { listProofAssets } from "./assets.js";
import { listTransfers } from "./transfers.js";
import { listContinuityEvaluations } from "./continuity.js";
import { listAssetBindings } from "./asset-bindings.js";
import { requireWorkflowType } from "./workflow.js";

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
    const participationPolicy = requireParticipationPolicy(
      proof.participation_policy,
      DEFAULT_PARTICIPATION_POLICY,
    );
    const merchantOptional = participationPolicy === "COUNTERPARTY_OPTIONAL";

    const participants = await tx.query<ParticipantRow>(
      `SELECT * FROM proof_participants WHERE proof_id = $1`,
      [proofId],
    );
    const pendingEvidence = await tx.query<EvidenceRow>(
      `SELECT * FROM evidence
        WHERE proof_id = $1 AND validation_status = 'PENDING'`,
      [proofId],
    );
    const evidence = await tx.query<EvidenceRow>(
      `SELECT * FROM evidence
        WHERE proof_id = $1 AND validation_status = 'COMMITTED'
        ORDER BY committed_at ASC, id ASC`,
      [proofId],
    );
    const attestations = await tx.query<AttestationRow>(
      `SELECT * FROM attestations WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
      [proofId],
    );
    const packingAttested = attestations.rows.some(
      (row) => row.statement === "PACKED_DESCRIBED_ITEM" && row.attested_by === actorUserId,
    );
    const observations = await listObservations(tx, proofId);
    const workflowType = requireWorkflowType(proof.workflow_type);
    const evaluation = evaluateFinalizeRequirements({
      participationPolicy,
      workflowType,
      proofStatus: proof.status,
      hasSeller: participants.rows.some((row) => row.role === "SELLER"),
      hasBuyer: participants.rows.some((row) => row.role === "BUYER"),
      pendingEvidenceCount: pendingEvidence.rows.length,
      committedEvidenceCount: evidence.rows.length,
      committedFulfillmentCaptureCount: evidence.rows.filter((row) =>
        isQualifyingFulfillmentCapture({
          evidenceType: row.evidence_type,
          validationStatus: row.validation_status,
        }),
      ).length,
      packingAttested,
      packed: observations.some((row) => row.type === "PACKED"),
      released: observations.some((row) => row.type === "RELEASED"),
      received: observations.some((row) => row.type === "RECEIVED"),
      finalReceipt: observations.some((row) => row.type === "FINAL_RECEIPT"),
    });
    if (!evaluation.ok) {
      throw new DomainError(evaluation.code, evaluation.message, 422);
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
    const identity = await tx.query<TransactionIntegrationIdentityRow>(
      `SELECT * FROM transaction_integration_identities
        WHERE transaction_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [proof.transaction_id],
    );
    const provenance = manifestProvenance(
      provenanceFromIdentity(identity.rows[0] ?? null, txn.transaction_metadata),
    );

    const now = clock.now();
    const auditEventIds = await listAuditIds(tx, proofId);
    const manifestId = newId("man");
    const storedItems = await listTransactionItems(tx, proof.transaction_id);
    const payload: Record<string, unknown> = {
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
        ...(provenance ? { provenance } : {}),
        ...(storedItems.length > 0
          ? {
              items: storedItems.map((item) => ({
                itemId: item.itemId,
                externalItemId: item.externalItemId,
                position: item.position,
                title: item.title,
                description: item.description,
                sku: item.sku,
                quantity: item.quantity,
                unitValue: item.unitValue,
                currency: item.currency,
              })),
            }
          : {}),
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
    if (merchantOptional) {
      payload.participationPolicy = participationPolicy;
      payload.attestations = attestations.rows.map((row) => ({
        attestationId: row.id,
        attestedBy: row.attested_by,
        statement: row.statement,
        relatedEvidenceId: row.related_evidence_id,
        createdAt: asRequiredIso(row.created_at),
        sha256: row.sha256,
      }));
    }

    if (workflowType !== "COMMERCE_SALE" || observations.length > 0) {
      const assets = await listProofAssets(tx, proofId);
      const transfers = await listTransfers(tx, proofId);
      const continuity = await listContinuityEvaluations(tx, proofId);
      const bindings = await listAssetBindings(tx, proofId);
      payload.workflowType = workflowType;
      payload.assets = assets.map((asset) => ({
        assetId: asset.assetId,
        assetInstanceId: asset.assetInstanceId,
        assetType: asset.assetType,
        catalogDescriptor: asset.catalogDescriptor,
        labelIndex: asset.labelIndex,
        createdAt: asset.createdAt,
      }));
      payload.observations = observations.map((observation) => ({
        observationId: observation.observationId,
        type: observation.type,
        occurredAt: observation.occurredAt,
        serverRecordedAt: observation.serverRecordedAt,
        actorParticipantId: observation.actorParticipantId,
        assetIds: observation.assetIds,
        evidence: observation.evidence,
      }));
      payload.transfers = transfers.map((transfer) => ({
        transferId: transfer.transferId,
        fromObservationId: transfer.fromObservationId,
        toObservationId: transfer.toObservationId,
        transferType: transfer.transferType,
        status: transfer.status,
        carrierContext: transfer.carrierContext,
      }));
      payload.continuityObservations = continuity.map((row) => ({
        evaluationId: row.evaluationId,
        fromObservationId: row.fromObservationId,
        toObservationId: row.toObservationId,
        algorithmVersion: row.algorithmVersion,
        result: row.result,
        summary: row.summary,
        evidencePairs: row.evidencePairs,
        createdAt: row.createdAt,
      }));
      payload.externalBindings = bindings.map((row) => ({
        bindingId: row.bindingId,
        assetId: row.assetId,
        transferId: row.transferId,
        tenantKey: row.tenantKey,
        externalId: row.externalId,
        scope: row.scope,
        source: row.source,
        createdAt: row.createdAt,
      }));
    }

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
