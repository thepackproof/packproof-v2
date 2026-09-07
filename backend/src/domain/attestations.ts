import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import { strictAttestationObject, verifyAttestationAuthorization } from "./attestation-authorization.js";
import { getProofView, loadProof, requireParticipant, type ProofView } from "./proofs.js";
import { ATTESTATION_STATEMENTS, DIGEST_ALGORITHM, TRUST_KIND } from "./trust.js";
import {
  asRequiredIso,
  type AttestationRow,
  type AttestationAuthorization,
  type AttestationStatement,
  type EvidenceRow,
} from "./types.js";

export interface AttestationView {
  kind: typeof TRUST_KIND.ATTESTATION;
  attestationId: string;
  proofId: string;
  participantId: string;
  attestedBy: string;
  statement: AttestationStatement | string;
  relatedEvidenceId: string | null;
  relatedEventId: string | null;
  createdAt: string;
  authorization?: AttestationAuthorization;
  digest: {
    algorithm: typeof DIGEST_ALGORITHM;
    sha256: string;
  };
}

export interface AttestationCommitView {
  attestation: AttestationView;
  proof: ProofView;
}

export function toAttestationView(row: AttestationRow): AttestationView {
  return {
    kind: TRUST_KIND.ATTESTATION,
    attestationId: row.id,
    proofId: row.proof_id,
    participantId: row.participant_id,
    attestedBy: row.attested_by,
    statement: row.statement,
    relatedEvidenceId: row.related_evidence_id,
    relatedEventId: row.related_event_id,
    createdAt: asRequiredIso(row.created_at),
    ...(row.authorization_json ? { authorization: row.authorization_json } : {}),
    digest: {
      algorithm: DIGEST_ALGORITHM,
      sha256: row.sha256,
    },
  };
}

export async function listAttestations(
  db: Database,
  proofId: string,
): Promise<AttestationView[]> {
  const found = await db.query<AttestationRow>(
    `SELECT * FROM attestations WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toAttestationView);
}

export async function commitAttestation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    statement?: string;
    relatedEvidenceId?: string | null;
    authorization?: { challengeId: string; signature: string };
  },
): Promise<AttestationCommitView> {
  strictAttestationObject(input, ["statement", "relatedEvidenceId", "authorization"]);
  if (input.relatedEvidenceId != null && (typeof input.relatedEvidenceId !== "string" || input.relatedEvidenceId.length > 256)) {
    throw new DomainError("INVALID_ATTESTATION", "relatedEvidenceId must identify evidence on this Proof", 400);
  }
  const statement = normalizeStatement(input.statement);
  const relatedEvidenceId = input.relatedEvidenceId?.trim() || null;

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    const participant = await requireParticipant(tx, proofId, actorUserId);
    let relatedEvidence: EvidenceRow | undefined;
    if (relatedEvidenceId) {
      const evidence = await tx.query<EvidenceRow>(
        `SELECT * FROM evidence WHERE id = $1 AND proof_id = $2`,
        [relatedEvidenceId, proofId],
      );
      if (!evidence.rows[0]) {
        throw new DomainError(
          "INVALID_ATTESTATION",
          "relatedEvidenceId is not evidence on this Proof",
          400,
        );
      }
      relatedEvidence = evidence.rows[0];
    }

    let authorization: AttestationAuthorization | undefined;
    if (input.authorization !== undefined) {
      if (participant.role !== "SELLER" || statement !== "PACKED_DESCRIBED_ITEM"
        || (proof.workflow_type ?? "COMMERCE_SALE") !== "COMMERCE_SALE") {
        throw new DomainError("INVALID_ATTESTATION", "Signed shipping attestation requires the seller's packing statement", 400);
      }
      const verified = await verifyAttestationAuthorization(tx, clock, actorUserId, proofId, input.authorization, relatedEvidence);
      authorization = verified.authorization;
      if (verified.attestationId) {
        const recorded = (await tx.query<AttestationRow>("SELECT * FROM attestations WHERE id=$1", [verified.attestationId])).rows[0];
        if (!recorded || recorded.related_evidence_id !== relatedEvidenceId || recorded.statement !== statement
          || recorded.authorization_json?.challengeId !== authorization.challengeId) {
          throw new DomainError("ATTESTATION_AUTHORIZATION_CONFLICT", "This challenge already belongs to another attestation", 409);
        }
        return { attestation: toAttestationView(recorded), proof: await getProofView(tx, proofId) };
      }
    }
    if (proof.status === "FINALIZED") {
      throw new DomainError("PROOF_ALREADY_FINALIZED", "Finalized Proofs cannot accept attestations", 409);
    }

    const existing = relatedEvidenceId
      ? await tx.query<AttestationRow>(
          `SELECT * FROM attestations
            WHERE proof_id = $1 AND attested_by = $2 AND statement = $3
              AND related_evidence_id = $4`,
          [proofId, actorUserId, statement, relatedEvidenceId],
        )
      : await tx.query<AttestationRow>(
          `SELECT * FROM attestations
            WHERE proof_id = $1 AND attested_by = $2 AND statement = $3
              AND related_evidence_id IS NULL`,
          [proofId, actorUserId, statement],
        );
    if (existing.rows[0]) {
      if (authorization) {
        throw new DomainError("ATTESTATION_AUTHORIZATION_CONFLICT", "This recording already has a different attestation; retry its original authorization", 409);
      }
      return {
        attestation: toAttestationView(existing.rows[0]),
        proof: await getProofView(tx, proofId),
      };
    }

    const now = clock.now();
    const attestationId = newId("att");
    const createdAt = now.toISOString();
    const digestPayload = {
      proofId,
      attestedBy: actorUserId,
      statement,
      relatedEvidenceId,
      createdAt,
      ...(authorization ? { authorization } : {}),
    };
    const digest = sha256Hex(canonicalize(digestPayload));
    const eventId = await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "ATTESTATION_COMMITTED",
      eventData: { attestationId, statement, relatedEvidenceId, sha256: digest,
        ...(authorization ? { authorization: { method: authorization.method, challengeId: authorization.challengeId,
          signatureVerification: authorization.signatureVerification, biometricMethodProvenance: authorization.biometricMethodProvenance } } : {}) },
      at: now,
    });

    // loadProof(..., true) serializes the uniqueness check and insert for this Proof.
    await tx.query(
      `INSERT INTO attestations (
         id, proof_id, participant_id, attested_by, statement,
         related_evidence_id, related_event_id, sha256, created_at, authorization_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        attestationId,
        proofId,
        participant.id,
        actorUserId,
        statement,
        relatedEvidenceId,
        eventId,
        digest,
        createdAt,
        authorization ? JSON.stringify(authorization) : null,
      ],
    );
    if (authorization) {
      await tx.query("UPDATE attestation_challenges SET consumed_at=$2, attestation_id=$3 WHERE id=$1 AND consumed_at IS NULL",
        [authorization.challengeId, createdAt, attestationId]);
    }

    return {
      attestation: toAttestationView({
        id: attestationId,
        proof_id: proofId,
        participant_id: participant.id,
        attested_by: actorUserId,
        statement,
        related_evidence_id: relatedEvidenceId,
        related_event_id: eventId,
        sha256: digest,
        created_at: createdAt,
        authorization_json: authorization ?? null,
      }),
      proof: await getProofView(tx, proofId),
    };
  });
}

function normalizeStatement(value: string | undefined): AttestationStatement {
  if (value !== undefined && typeof value !== "string") throw new DomainError("INVALID_ATTESTATION", "statement must be a recorded attestation type", 400);
  const statement = (value ?? "").trim();
  if (!ATTESTATION_STATEMENTS.includes(statement as AttestationStatement)) {
    throw new DomainError(
      "INVALID_ATTESTATION",
      "statement is not a recorded attestation type",
      400,
    );
  }
  return statement as AttestationStatement;
}
