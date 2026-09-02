import type { Database } from "../db/database.js";
import { listAuditEvents, type AuditEventView } from "./audit.js";
import { buildChronology, type ChronologyEntry } from "./chronology.js";
import { DomainError } from "./errors.js";
import {
  listProofExternalReferences,
  type ProofExternalReferenceView,
} from "./external-references.js";
import {
  getShipmentObservationsForProof,
  type ShipmentObservationsView,
} from "./shipment-events.js";
import {
  getShipmentSyncAvailability,
  type ShipmentSyncAvailability,
} from "./integration-connections.js";
import { loadTransactionView, type TransactionView } from "./transactions.js";
import {
  CANONICAL_PROOF_SCHEMA,
  DIGEST_ALGORITHM,
  TRUST_KIND,
} from "./trust.js";
import {
  asIso,
  asRequiredIso,
  type AttestationRow,
  type EvidenceRow,
  type InvitationRow,
  type ManifestRow,
  type ParticipantRow,
  type ProofRow,
} from "./types.js";
import {
  DEFAULT_PARTICIPATION_POLICY,
  requireParticipationPolicy,
  type ParticipationPolicy,
} from "./participation.js";
import { loadCustodyBundle } from "./custody.js";
import { isQualifyingFulfillmentCapture } from "./evidence-types.js";
import type { ProofAssetView } from "./assets.js";
import type { ObservationView } from "./observations.js";
import type { TransferView } from "./transfers.js";
import type { ContinuityView } from "./continuity.js";
import type { AssetExternalRefView } from "./asset-bindings.js";
import type { NextAction } from "./workflow.js";

export interface CanonicalParticipant {
  participantId: string;
  userId: string;
  role: string;
  status: "JOINED";
  invitationState: "ACCEPTED";
  authorization: "PARTICIPANT";
  joinedAt: string;
}

export interface CanonicalEvidence {
  evidenceId: string;
  evidenceType: string;
  validationStatus: string;
  submittedBy: string;
  createdAt: string;
  receivedAt: string;
  committedAt: string | null;
  objectKey: string;
  contentType: string;
  sha256: string | null;
  byteSize: number | null;
  digest: {
    algorithm: typeof DIGEST_ALGORITHM;
    sha256: string;
  } | null;
}

export interface CanonicalInvitation {
  invitationId: string;
  inviteeIdentifier: string;
  inviteeUserId: string | null;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
}

export interface CanonicalAttestation {
  kind: typeof TRUST_KIND.ATTESTATION;
  attestationId: string;
  participantId: string;
  attestedBy: string;
  statement: string;
  relatedEvidenceId: string | null;
  relatedEventId: string | null;
  createdAt: string;
  digest: {
    algorithm: typeof DIGEST_ALGORITHM;
    sha256: string;
  };
}

export interface CanonicalFact {
  kind: typeof TRUST_KIND.FACT;
  name: string;
  at: string;
  data: Record<string, unknown>;
}

export interface CanonicalExternalRecord {
  kind: typeof TRUST_KIND.EXTERNAL;
  field: string;
  value: unknown;
  source: "PARTICIPANT_SUPPLIED" | "INTEGRATION";
  verifiedByPackProof: false;
}

export interface CanonicalProof {
  schema: typeof CANONICAL_PROOF_SCHEMA;
  proofId: string;
  transactionId: string;
  status: string;
  participationPolicy: ParticipationPolicy;
  version: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  manifestId: string | null;
  identity: {
    proofId: string;
    transactionId: string;
    status: string;
    version: number;
    createdAt: string;
    updatedAt: string;
    finalizedAt: string | null;
  };
  transaction: TransactionView;
  participants: CanonicalParticipant[];
  invitations: CanonicalInvitation[];
  evidence: CanonicalEvidence[];
  attestations: CanonicalAttestation[];
  events: AuditEventView[];
  integrity: {
    algorithm: typeof DIGEST_ALGORITHM;
    evidence: Array<{
      evidenceId: string;
      sha256: string;
      byteSize: number | null;
      objectKey: string;
    }>;
    manifestId: string | null;
    manifestSha256: string | null;
  };
  facts: CanonicalFact[];
  external: {
    records: CanonicalExternalRecord[];
    references: ProofExternalReferenceView[];
  };
  shipmentObservations: ShipmentObservationsView;
  shipmentSync: ShipmentSyncAvailability;
  chronology: ChronologyEntry[];
  workflowType: string;
  workflowStage: string;
  nextAction: NextAction | null;
  assets: ProofAssetView[];
  observations: ObservationView[];
  transfers: TransferView[];
  continuityObservations: ContinuityView[];
  transactionContext: TransactionView;
  shippingContext: TransactionView["shipping"];
  externalBindings: Array<ProofExternalReferenceView | AssetExternalRefView>;
  auditEvents: AuditEventView[];
}

export async function getCanonicalProof(
  db: Database,
  proofId: string,
  actorUserId?: string | null,
): Promise<CanonicalProof> {
  const proofResult = await db.query<ProofRow>(`SELECT * FROM proofs WHERE id = $1`, [proofId]);
  const proof = proofResult.rows[0];
  if (!proof) {
    throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  }

  const transaction = await loadTransactionView(db, proof.transaction_id);
  const participants = await db.query<ParticipantRow>(
    `SELECT * FROM proof_participants WHERE proof_id = $1 ORDER BY role ASC, joined_at ASC`,
    [proofId],
  );
  const invitations = await db.query<InvitationRow>(
    `SELECT * FROM invitations WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  const evidence = await db.query<EvidenceRow>(
    `SELECT * FROM evidence WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  const attestations = await db.query<AttestationRow>(
    `SELECT * FROM attestations WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  const events = await listAuditEvents(db, proofId);
  const references = await listProofExternalReferences(db, proofId);
  const shipmentObservations = await getShipmentObservationsForProof(
    db,
    proofId,
    proof.transaction_id,
  );
  const shipmentSync = await getShipmentSyncAvailability(db, proof.transaction_id);
  const manifest = proof.manifest_id
    ? await db.query<ManifestRow>(`SELECT * FROM final_manifests WHERE proof_id = $1`, [proofId])
    : { rows: [] as ManifestRow[] };
  const manifestRow = manifest.rows[0] ?? null;

  const createdAt = asRequiredIso(proof.created_at);
  const updatedAt = asRequiredIso(proof.updated_at);
  const finalizedAt = asIso(proof.finalized_at);
  const participantViews = participants.rows.map(
    (row): CanonicalParticipant => ({
      participantId: row.id,
      userId: row.user_id,
      role: row.role,
      status: "JOINED",
      invitationState: "ACCEPTED",
      authorization: "PARTICIPANT",
      joinedAt: asRequiredIso(row.joined_at),
    }),
  );
  const evidenceViews = evidence.rows.map(toCanonicalEvidence);
  const attestationViews = attestations.rows.map(
    (row): CanonicalAttestation => ({
      kind: TRUST_KIND.ATTESTATION,
      attestationId: row.id,
      participantId: row.participant_id,
      attestedBy: row.attested_by,
      statement: row.statement,
      relatedEvidenceId: row.related_evidence_id,
      relatedEventId: row.related_event_id,
      createdAt: asRequiredIso(row.created_at),
      digest: {
        algorithm: DIGEST_ALGORITHM,
        sha256: row.sha256,
      },
    }),
  );
  const actorRole =
    actorUserId == null
      ? null
      : participantViews.find((row) => row.userId === actorUserId)?.role ?? null;
  const custody = await loadCustodyBundle(db, proof, actorRole, {
    committedEvidenceCount: evidenceViews.filter((row) => row.validationStatus === "COMMITTED").length,
    packingAttested: attestations.rows.some((row) => row.statement === "PACKED_DESCRIBED_ITEM"),
    fulfillmentCaptureCount: evidence.rows.filter((row) =>
      isQualifyingFulfillmentCapture({
        evidenceType: row.evidence_type,
        validationStatus: row.validation_status,
      }),
    ).length,
  });

  return {
    schema: CANONICAL_PROOF_SCHEMA,
    proofId: proof.id,
    transactionId: proof.transaction_id,
    status: proof.status,
    participationPolicy: requireParticipationPolicy(
      proof.participation_policy,
      DEFAULT_PARTICIPATION_POLICY,
    ),
    version: Number(proof.version),
    createdAt,
    updatedAt,
    finalizedAt,
    manifestId: proof.manifest_id,
    identity: {
      proofId: proof.id,
      transactionId: proof.transaction_id,
      status: proof.status,
      version: Number(proof.version),
      createdAt,
      updatedAt,
      finalizedAt,
    },
    transaction,
    participants: participantViews,
    invitations: invitations.rows.map((row) => ({
      invitationId: row.id,
      inviteeIdentifier: row.invitee_identifier,
      inviteeUserId: row.invitee_user_id ?? null,
      status: row.status,
      createdAt: asRequiredIso(row.created_at),
      acceptedAt: asIso(row.accepted_at),
      expiresAt: asIso(row.expires_at),
    })),
    evidence: evidenceViews,
    attestations: attestationViews,
    events,
    integrity: {
      algorithm: DIGEST_ALGORITHM,
      evidence: evidenceViews
        .filter((row) => row.digest)
        .map((row) => ({
          evidenceId: row.evidenceId,
          sha256: row.digest!.sha256,
          byteSize: row.byteSize,
          objectKey: row.objectKey,
        })),
      manifestId: proof.manifest_id,
      manifestSha256: manifestRow?.sha256 ?? null,
    },
    facts: collectFacts({
      proofId: proof.id,
      createdAt,
      finalizedAt,
      participants: participantViews,
      evidence: evidenceViews,
      events,
      manifestSha256: manifestRow?.sha256 ?? null,
      manifestCreatedAt: manifestRow ? asRequiredIso(manifestRow.created_at) : null,
    }),
    external: {
      records: collectExternalRecords(transaction),
      references,
    },
    shipmentObservations,
    shipmentSync,
    chronology: buildChronology({
      transaction,
      events,
      shipmentEvents: shipmentObservations.events,
    }),
    workflowType: custody.workflowType,
    workflowStage: custody.policy.workflowStage,
    nextAction: custody.policy.nextAction,
    assets: custody.assets,
    observations: custody.observations,
    transfers: custody.transfers,
    continuityObservations: custody.continuity,
    transactionContext: transaction,
    shippingContext: transaction.shipping,
    externalBindings: [...references, ...custody.bindings],
    auditEvents: events,
  };
}

function toCanonicalEvidence(row: EvidenceRow): CanonicalEvidence {
  const createdAt = asRequiredIso(row.created_at);
  return {
    evidenceId: row.id,
    evidenceType: row.evidence_type,
    validationStatus: row.validation_status,
    submittedBy: row.submitted_by,
    createdAt,
    receivedAt: createdAt,
    committedAt: asIso(row.committed_at),
    objectKey: row.object_key,
    contentType: row.content_type,
    sha256: row.sha256,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    digest: row.sha256
      ? {
          algorithm: DIGEST_ALGORITHM,
          sha256: row.sha256,
        }
      : null,
  };
}

function collectFacts(input: {
  proofId: string;
  createdAt: string;
  finalizedAt: string | null;
  participants: CanonicalParticipant[];
  evidence: CanonicalEvidence[];
  events: AuditEventView[];
  manifestSha256: string | null;
  manifestCreatedAt: string | null;
}): CanonicalFact[] {
  const facts: CanonicalFact[] = [
    {
      kind: TRUST_KIND.FACT,
      name: "PROOF_RECORDED",
      at: input.createdAt,
      data: { proofId: input.proofId },
    },
  ];

  for (const participant of input.participants) {
    facts.push({
      kind: TRUST_KIND.FACT,
      name: "PARTICIPANT_RECORDED",
      at: participant.joinedAt,
      data: {
        participantId: participant.participantId,
        userId: participant.userId,
        role: participant.role,
      },
    });
  }

  for (const evidence of input.evidence) {
    facts.push({
      kind: TRUST_KIND.FACT,
      name: "EVIDENCE_RECORD_RECEIVED",
      at: evidence.receivedAt,
      data: {
        evidenceId: evidence.evidenceId,
        submittedBy: evidence.submittedBy,
        contentType: evidence.contentType,
      },
    });
    if (evidence.digest && evidence.committedAt) {
      facts.push({
        kind: TRUST_KIND.FACT,
        name: "EVIDENCE_DIGEST_RECORDED",
        at: evidence.committedAt,
        data: {
          evidenceId: evidence.evidenceId,
          algorithm: DIGEST_ALGORITHM,
          sha256: evidence.digest.sha256,
          byteSize: evidence.byteSize,
        },
      });
    }
  }

  if (input.manifestSha256 && input.manifestCreatedAt) {
    facts.push({
      kind: TRUST_KIND.FACT,
      name: "MANIFEST_DIGEST_RECORDED",
      at: input.manifestCreatedAt,
      data: {
        algorithm: DIGEST_ALGORITHM,
        sha256: input.manifestSha256,
      },
    });
  }

  if (input.finalizedAt) {
    const finalizedEvent = input.events.find((event) => event.eventType === "PROOF_FINALIZED");
    facts.push({
      kind: TRUST_KIND.FACT,
      name: "PROOF_FINALIZED",
      at: input.finalizedAt,
      data: {
        proofId: input.proofId,
        eventId: finalizedEvent?.eventId ?? null,
      },
    });
  }

  return facts;
}

function collectExternalRecords(transaction: TransactionView): CanonicalExternalRecord[] {
  const fieldSource: CanonicalExternalRecord["source"] = transaction.provenance
    ? "INTEGRATION"
    : "PARTICIPANT_SUPPLIED";
  const records: Array<{ field: string; value: unknown }> = [
    { field: "transaction.externalReference", value: transaction.externalReference },
    { field: "transaction.transactionDate", value: transaction.transactionDate },
    { field: "transaction.itemTitle", value: transaction.itemTitle },
    { field: "transaction.itemDescription", value: transaction.itemDescription },
    { field: "transaction.quantity", value: transaction.quantity },
    { field: "transaction.items", value: transaction.items.some((item) => item.itemId) ? transaction.items : null },
    { field: "transaction.transactionValue", value: transaction.transactionValue },
    { field: "transaction.currency", value: transaction.currency },
    { field: "transaction.metadata", value: transaction.metadata },
    { field: "shipping.carrier", value: transaction.shipping?.carrier ?? null },
    { field: "shipping.service", value: transaction.shipping?.service ?? null },
    { field: "shipping.trackingNumber", value: transaction.shipping?.trackingNumber ?? null },
    { field: "shipping.shipmentDate", value: transaction.shipping?.shipmentDate ?? null },
  ];
  if (transaction.provenance) {
    records.push(
      { field: "transaction.provenance.source", value: transaction.provenance.source },
      { field: "transaction.provenance.provider", value: transaction.provenance.provider },
      { field: "transaction.provenance.adapterKey", value: transaction.provenance.adapterKey },
      { field: "transaction.provenance.tenantKey", value: transaction.provenance.tenantKey },
    );
  }

  return records
    .filter((record) => record.value != null && record.value !== "")
    .map((record) => ({
      kind: TRUST_KIND.EXTERNAL,
      field: record.field,
      value: record.value,
      source: fieldSource,
      verifiedByPackProof: false as const,
    }));
}
