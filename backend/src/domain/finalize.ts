import { assertAttestationContextCurrent, readAttestationContext } from "./attestation-context.js";
import { assertShippingReviewComplete } from "./capture-label-review.js";
import { readCaptureClientContext } from "./capture-sessions.js";
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
import { listObservations, originDocumentedAssetIds } from "./observations.js";
import { listProofAssets } from "./assets.js";
import { listTransfers } from "./transfers.js";
import { listContinuityEvaluations } from "./continuity.js";
import { listAssetBindings } from "./asset-bindings.js";
import { custodyOutcomeFor, requireWorkflowType } from "./workflow.js";
import { requireManifestSignatureAlgorithm, type ManifestSigner, type ManifestSignature } from "./manifest-signing.js";
import { buildProofRecoverySnapshot, enqueueRecoveryEvent, getRecoveryStatus, requireDurableOperation, type RecoveryStatus } from "./recovery-journal.js";

export interface ManifestView {
  manifestId: string;
  proofId: string;
  sha256: string;
  manifest: unknown;
  canonicalJson: string;
  signature?: ManifestSignature;
}

function signatureFromRow(row: ManifestRow): { signature?: ManifestSignature } {
  return row.signature_base64 ? { signature: { algorithm: requireManifestSignatureAlgorithm(row.signature_algorithm), keyId: row.signing_key_id!, signatureBase64: row.signature_base64, signedAt: asRequiredIso(row.signed_at!) } } : {};
}

export interface FinalizeView {
  proof: ProofView;
  manifest: ManifestView;
  recovery?: RecoveryStatus;
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
  const proof = await loadProof(db, proofId);
  if (proof.status !== "FINALIZED") throw new DomainError("PRESERVATION_PENDING", "The signed manifest is prepared; final preservation is still in progress", 409);
  return {
    manifestId: row.id,
    proofId: row.proof_id,
    sha256: row.sha256,
    canonicalJson: row.canonical_json,
    manifest: JSON.parse(row.canonical_json) as unknown,
    ...signatureFromRow(row),
  };
}

export async function finalizeProof(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  signer?: ManifestSigner,
  options: { requireDurableReceipts?: boolean } = {},
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
        recovery: await getRecoveryStatus(tx, `finalize:${proofId}`),
        manifest: {
          manifestId: existing.rows[0].id,
          proofId,
          sha256: existing.rows[0].sha256,
          canonicalJson: existing.rows[0].canonical_json,
          manifest: JSON.parse(existing.rows[0].canonical_json) as unknown,
          ...signatureFromRow(existing.rows[0]),
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
    if (options.requireDurableReceipts) {
      if (!signer) throw new DomainError("MANIFEST_SIGNING_UNAVAILABLE", "Signing is required before finalization; retry once service is restored", 503);
      for (const row of evidence.rows) await requireDurableOperation(tx, `evidence:${row.id}`);
    }
    const eligibleSessions = (await tx.query<{id: string; policy_version:string; client:string; recorded_at:string|Date;expires_at:string|Date}>(
      `SELECT c.id,c.policy_version,c.client,c.recorded_at,c.expires_at FROM capture_sessions c JOIN evidence e ON e.id=c.evidence_id
       WHERE c.proof_id=$1 AND c.state='COMMITTED' AND c.actor_user_id=e.submitted_by
         AND e.capture_session_id=c.id AND c.expected_sha256=e.sha256
         AND c.expected_byte_size=e.byte_size`, [proofId]
    )).rows;
    const captureContexts=new Map(await Promise.all(eligibleSessions.map(async session=>[session.id,await readCaptureClientContext(tx,session.id)] as const)));
    const eligibleSessionIds = new Set(eligibleSessions.map(row=>row.id));
    if (evidence.rows.some(row => row.capture_session_id && !eligibleSessionIds.has(row.capture_session_id)))
      throw new DomainError("CAPTURE_SESSION_CONFLICT", "Committed capture context does not match its original evidence", 409);
    const attestations = await tx.query<AttestationRow>(
      `SELECT * FROM attestations WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
      [proofId],
    );
    for (const session of eligibleSessions) await assertShippingReviewComplete(tx, proofId, session.id);
    for (const row of attestations.rows) {
      // Preserve historically committed version-1 authorizations and manifests.
      if (row.authorization_json && readAttestationContext(row.authorization_json.payload).contextVersion === 1) {
        await assertAttestationContextCurrent(tx, proof.transaction_id, row.authorization_json.payload);
      }
    }
    const packingAttested = attestations.rows.some(
      (row) => row.statement === "PACKED_DESCRIBED_ITEM" && row.attested_by === actorUserId
        && (!options.requireDurableReceipts || evidence.rows.some(item => item.id === row.related_evidence_id
          && item.submitted_by === actorUserId && item.evidence_type === "FULFILLMENT_CAPTURE"
          && (!item.capture_session_id || eligibleSessionIds.has(item.capture_session_id)))),
    );
    if (options.requireDurableReceipts) for (const row of attestations.rows) await requireDurableOperation(tx, `declaration:${row.id}`);
    const observations = await listObservations(tx, proofId);
    const workflowType = requireWorkflowType(proof.workflow_type);
    const assets = workflowType === "GRADING_SUBMISSION" ? await listProofAssets(tx, proofId) : [];
    const committedIds = new Set(evidence.rows.map((row) => row.id));
    const documentedAssetIds = originDocumentedAssetIds(observations.filter(
      (row) => row.evidence.every((link) => committedIds.has(link.evidenceId)),
    ));
    const evaluation = evaluateFinalizeRequirements({
      participationPolicy,
      workflowType,
      proofStatus: proof.status,
      hasSeller: participants.rows.some((row) => row.role === "SELLER"),
      hasBuyer: participants.rows.some((row) => row.role === "BUYER"),
      pendingEvidenceCount: pendingEvidence.rows.length,
      committedEvidenceCount: evidence.rows.length,
      committedFulfillmentCaptureCount: evidence.rows.filter((row) =>
        (row.capture_origin === "LEGACY_UNKNOWN" || (row.capture_origin === "AUTHORIZED_CAPTURE_SESSION" && !!row.capture_session_id && eligibleSessionIds.has(row.capture_session_id))) &&
        isQualifyingFulfillmentCapture({
          evidenceType: row.evidence_type,
          validationStatus: row.validation_status,
        }),
      ).length,
      packingAttested,
      assetCount: assets.length,
      documentedAssetCount: assets.filter((asset) => documentedAssetIds.has(asset.assetId)).length,
      packed: observations.some((row) => row.type === "PACKED"),
      released: observations.some((row) => row.type === "RELEASED"),
      received: observations.some((row) => row.type === "RECEIVED"),
      intakeCaptured: observations.some((row) => row.type === "INTAKE_CAPTURE"),
      compared: (await listContinuityEvaluations(tx, proofId)).length > 0,
      processOutput: observations.some((row) => row.type === "PROCESS_OUTPUT"),
      returnPacked: observations.some((row) => row.type === "RETURN_PACKED"),
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
        ...(row.capture_session_id ? { capture: {
          sessionId: row.capture_session_id,
          clientReportedCapture: captureContexts.get(row.capture_session_id)??null,
          policyVersion: eligibleSessions.find(session=>session.id===row.capture_session_id)?.policy_version,
          client: eligibleSessions.find(session=>session.id===row.capture_session_id)?.client,
          registeredAt: asRequiredIso(eligibleSessions.find(session=>session.id===row.capture_session_id)!.recorded_at),
          origin: "AUTHORIZED_CAPTURE_SESSION",
          registrationTiming: new Date(eligibleSessions.find(session=>session.id===row.capture_session_id)!.recorded_at).getTime()>new Date(eligibleSessions.find(session=>session.id===row.capture_session_id)!.expires_at).getTime() ? "DELAYED_NOT_INDEPENDENTLY_ATTESTED" : "WITHIN_START_WINDOW",
          assurance: "Workflow authorization; camera origin and offline timing are not independently attested.",
        }} : {}),
        objectKey: row.object_key,
        ...((row as EvidenceRow & {object_version_id?: string}).object_version_id ? { objectVersionId: (row as EvidenceRow & {object_version_id: string}).object_version_id } : {}),
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
    if (merchantOptional) payload.participationPolicy = participationPolicy;
    if (merchantOptional || eligibleSessions.length > 0) {
      payload.attestations = attestations.rows.map((row) => ({
        attestationId: row.id,
        attestedBy: row.attested_by,
        statement: row.statement,
        ...(row.authorization_json ? { authorization: row.authorization_json } : {}),
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
      payload.custodyOutcome = custodyOutcomeFor({
        workflowType,
        proofStatus: "FINALIZED",
        released: observations.some((row) => row.type === "RELEASED"),
        received: observations.some((row) => row.type === "RECEIVED"),
        finalReceipt: observations.some((row) => row.type === "FINAL_RECEIPT"),
      });
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
        actorParticipantId: row.actorParticipantId,
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

    const signature = signer ? await signer.signManifest({ proofId, manifestId, canonicalJson, sha256: digest }) : null;
    await tx.query(
      `INSERT INTO final_manifests (id, proof_id, canonical_json, sha256, created_at, signature_algorithm, signature_base64, signing_key_id, signed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [manifestId, proofId, canonicalJson, digest, now.toISOString(), signature?.algorithm ?? null, signature?.signatureBase64 ?? null, signature?.keyId ?? null, signature?.signedAt ?? null],
    );
    if (!options.requireDurableReceipts) await tx.query(
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
      eventType: options.requireDurableReceipts ? "PROOF_FINALIZATION_PREPARED" : "PROOF_FINALIZED",
      eventData: { manifestId, sha256: digest },
      at: now,
    });
    const recovery = await enqueueRecoveryEvent(tx, clock, { operationId: `finalize:${proofId}`, kind: "PROOF_FINALIZED", proofId, actorUserId, payload: await buildProofRecoverySnapshot(tx, proofId) });

    return {
      proof: await getProofView(tx, proofId),
      recovery,
      manifest: {
        manifestId,
        proofId,
        sha256: digest,
        canonicalJson,
        manifest: JSON.parse(canonicalJson) as unknown,
        ...(signature ? { signature } : {}),
      },
    };
  });
}

export function hashCanonicalManifest(manifest: unknown): { canonicalJson: string; sha256: string } {
  const canonicalJson = canonicalize(manifest);
  return { canonicalJson, sha256: sha256Hex(canonicalJson) };
}
