import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId, newInvitationToken } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import {
  assertNotFinalized,
  getProofView,
  loadProof,
  requireParticipant,
  type ProofView,
} from "./proofs.js";
import {
  asIso,
  asRequiredIso,
  type InvitationRow,
  type ParticipantRow,
} from "./types.js";

export interface InvitationView {
  invitationId: string;
  proofId: string;
  inviteeIdentifier: string;
  status: string;
  token: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
}

function toInvitationView(row: InvitationRow): InvitationView {
  return {
    invitationId: row.id,
    proofId: row.proof_id,
    inviteeIdentifier: row.invitee_identifier,
    status: row.status,
    token: row.token,
    createdAt: asRequiredIso(row.created_at),
    acceptedAt: asIso(row.accepted_at),
    expiresAt: asIso(row.expires_at),
  };
}

export async function createInvitation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  inviteeIdentifier: string,
): Promise<{ invitation: InvitationView; proof: ProofView }> {
  const identifier = inviteeIdentifier.trim();
  if (!identifier) {
    throw new DomainError("INVALID_INVITEE", "inviteeIdentifier is required", 400);
  }

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");

    const existing = await tx.query<InvitationRow>(
      `SELECT * FROM invitations WHERE proof_id = $1 AND invitee_identifier = $2`,
      [proofId, identifier],
    );
    if (existing.rows[0]) {
      return {
        invitation: toInvitationView(existing.rows[0]),
        proof: await getProofView(tx, proofId),
      };
    }

    const now = clock.now();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const invitationId = newId("inv");
    const token = newInvitationToken();

    try {
      await tx.query(
        `INSERT INTO invitations (
           id, proof_id, inviter_user_id, invitee_identifier, status, token,
           created_at, expires_at
         ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7)`,
        [
          invitationId,
          proofId,
          actorUserId,
          identifier,
          token,
          now.toISOString(),
          expiresAt.toISOString(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await tx.query<InvitationRow>(
          `SELECT * FROM invitations WHERE proof_id = $1 AND invitee_identifier = $2`,
          [proofId, identifier],
        );
        if (raced.rows[0]) {
          return {
            invitation: toInvitationView(raced.rows[0]),
            proof: await getProofView(tx, proofId),
          };
        }
      }
      throw error;
    }

    if (proof.status === "OPEN") {
      await tx.query(
        `UPDATE proofs SET status = 'AWAITING_PARTICIPANT', updated_at = $2 WHERE id = $1`,
        [proofId, now.toISOString()],
      );
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PARTICIPANT_INVITED",
      eventData: { invitationId, inviteeIdentifier: identifier },
      at: now,
    });

    return {
      invitation: toInvitationView({
        id: invitationId,
        proof_id: proofId,
        inviter_user_id: actorUserId,
        invitee_identifier: identifier,
        status: "PENDING",
        token,
        created_at: now.toISOString(),
        accepted_at: null,
        expires_at: expiresAt.toISOString(),
      }),
      proof: await getProofView(tx, proofId),
    };
  });
}

export async function acceptInvitation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  token: string,
): Promise<{ invitation: InvitationView; proof: ProofView }> {
  return db.transaction(async (tx) => {
    const found = await tx.query<InvitationRow>(
      `SELECT * FROM invitations WHERE token = $1 FOR UPDATE`,
      [token],
    );
    const invitation = found.rows[0];
    if (!invitation) {
      throw new DomainError("INVITATION_NOT_FOUND", "Invitation not found", 404);
    }

    const proof = await loadProof(tx, invitation.proof_id, true);
    const now = clock.now();

    if (invitation.status === "REVOKED") {
      throw new DomainError("INVITATION_REVOKED", "Invitation has been revoked", 409);
    }

    if (
      invitation.status === "EXPIRED" ||
      (invitation.expires_at && new Date(invitation.expires_at).getTime() <= now.getTime())
    ) {
      if (invitation.status === "PENDING") {
        await tx.query(
          `UPDATE invitations SET status = 'EXPIRED' WHERE id = $1`,
          [invitation.id],
        );
      }
      throw new DomainError("INVITATION_EXPIRED", "Invitation has expired", 409);
    }

    if (invitation.status === "ACCEPTED") {
      const existing = await tx.query<ParticipantRow>(
        `SELECT * FROM proof_participants
          WHERE proof_id = $1 AND role = 'BUYER'`,
        [invitation.proof_id],
      );
      if (existing.rows[0] && existing.rows[0].user_id !== actorUserId) {
        throw new DomainError(
          "INVITATION_ALREADY_ACCEPTED",
          "Invitation already accepted by another participant",
          409,
        );
      }
      return {
        invitation: toInvitationView(invitation),
        proof: await getProofView(tx, invitation.proof_id),
      };
    }

    assertNotFinalized(proof);
    const already = await tx.query<ParticipantRow>(
      `SELECT * FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
      [invitation.proof_id, actorUserId],
    );
    if (already.rows[0]) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "Actor is already a participant of this Proof",
        409,
      );
    }

    try {
      await tx.query(
        `INSERT INTO proof_participants (id, proof_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, 'BUYER', $4)`,
        [newId("prt"), invitation.proof_id, actorUserId, now.toISOString()],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await tx.query<ParticipantRow>(
          `SELECT * FROM proof_participants WHERE proof_id = $1 AND role = 'BUYER'`,
          [invitation.proof_id],
        );
        if (existing.rows[0]?.user_id === actorUserId) {
          return {
            invitation: toInvitationView(invitation),
            proof: await getProofView(tx, invitation.proof_id),
          };
        }
        throw new DomainError(
          "DUPLICATE_PARTICIPANT",
          "Buyer participant already exists",
          409,
        );
      }
      throw error;
    }

    await tx.query(
      `UPDATE invitations
          SET status = 'ACCEPTED', accepted_at = $2
        WHERE id = $1`,
      [invitation.id, now.toISOString()],
    );

    if (proof.status === "OPEN" || proof.status === "AWAITING_PARTICIPANT") {
      await tx.query(
        `UPDATE proofs SET status = 'READY_FOR_EVIDENCE', updated_at = $2 WHERE id = $1`,
        [invitation.proof_id, now.toISOString()],
      );
    }

    await appendAudit(tx, {
      proofId: invitation.proof_id,
      actorUserId,
      eventType: "PARTICIPANT_JOINED",
      eventData: { role: "BUYER", invitationId: invitation.id, userId: actorUserId },
      at: now,
    });

    const updatedInvitation = await tx.query<InvitationRow>(
      `SELECT * FROM invitations WHERE id = $1`,
      [invitation.id],
    );

    return {
      invitation: toInvitationView(updatedInvitation.rows[0]),
      proof: await getProofView(tx, invitation.proof_id),
    };
  });
}
