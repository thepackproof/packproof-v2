import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { getProofView, loadProof, requireParticipant, type ProofView } from "./proofs.js";
import { ATTESTATION_STATEMENTS, DIGEST_ALGORITHM, TRUST_KIND } from "./trust.js";
import {
  asRequiredIso,
  type AttestationRow,
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
  },
): Promise<AttestationCommitView> {
  const statement = normalizeStatement(input.statement);
  const relatedEvidenceId = input.relatedEvidenceId?.trim() || null;

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    if (proof.status === "FINALIZED") {
      throw new DomainError(
        "PROOF_ALREADY_FINALIZED",
        "Finalized Proofs cannot accept attestations",
        409,
      );
    }
    const participant = await requireParticipant(tx, proofId, actorUserId);

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
    };
    const digest = sha256Hex(canonicalize(digestPayload));
    const eventId = await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "ATTESTATION_COMMITTED",
      eventData: { attestationId, statement, relatedEvidenceId, sha256: digest },
      at: now,
    });

    try {
      await tx.query(
        `INSERT INTO attestations (
           id, proof_id, participant_id, attested_by, statement,
           related_evidence_id, related_event_id, sha256, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = relatedEvidenceId
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
        if (raced.rows[0]) {
          return {
            attestation: toAttestationView(raced.rows[0]),
            proof: await getProofView(tx, proofId),
          };
        }
      }
      throw error;
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
      }),
      proof: await getProofView(tx, proofId),
    };
  });
}

function normalizeStatement(value: string | undefined): AttestationStatement {
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
