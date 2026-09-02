import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId, newInvitationToken } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { searchUsers, type PublicProfileView } from "./profiles.js";
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
  type InvitationStatus,
  type ParticipantRow,
} from "./types.js";

export interface InvitationView {
  invitationId: string;
  proofId: string;
  inviteeIdentifier: string;
  inviteeUserId: string | null;
  status: string;
  token: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
}

export interface InvitationInboxView {
  invitationId: string;
  proofId: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  inviter: {
    userId: string;
    username: string | null;
    displayName: string | null;
  };
  transaction: {
    transactionId: string;
    itemTitle: string | null;
    externalReference: string | null;
  };
}

export type InvitationCreateInput = {
  inviteeIdentifier?: string;
  inviteeUserId?: string | null;
  userId?: string | null;
};

export type ProofInvitationState = "NONE" | "SELF" | "PARTICIPANT" | "INVITED" | "INELIGIBLE";

export interface ProofUserSearchResult extends PublicProfileView {
  invitationState: ProofInvitationState;
}

function toInvitationView(row: InvitationRow): InvitationView {
  return {
    invitationId: row.id,
    proofId: row.proof_id,
    inviteeIdentifier: row.invitee_identifier,
    inviteeUserId: row.invitee_user_id ?? null,
    status: row.status,
    token: row.token,
    createdAt: asRequiredIso(row.created_at),
    acceptedAt: asIso(row.accepted_at),
    expiresAt: asIso(row.expires_at),
  };
}

function resolveCreateInput(
  input: string | InvitationCreateInput,
): { identifier: string; inviteeUserId: string | null } {
  if (typeof input === "string") {
    const identifier = input.trim();
    if (!identifier) {
      throw new DomainError("INVALID_INVITEE", "inviteeIdentifier is required", 400);
    }
    return { identifier, inviteeUserId: null };
  }

  const inviteeUserId = (input.inviteeUserId ?? input.userId)?.trim() || null;
  if (inviteeUserId) {
    return {
      identifier: `user:${inviteeUserId}`,
      inviteeUserId,
    };
  }

  const identifier = (input.inviteeIdentifier ?? "").trim();
  if (!identifier) {
    throw new DomainError(
      "INVALID_INVITEE",
      "inviteeUserId or inviteeIdentifier is required",
      400,
    );
  }
  return { identifier, inviteeUserId: null };
}

export async function searchUsersForProof(
  db: Database,
  actorUserId: string,
  proofId: string,
  rawQuery: unknown,
): Promise<ProofUserSearchResult[]> {
  const proof = await loadProof(db, proofId);
  assertNotFinalized(proof);
  await requireParticipant(db, proofId, actorUserId, "SELLER");

  const users = await searchUsers(db, rawQuery);
  if (users.length === 0) {
    return [];
  }

  const participants = await db.query<{ user_id: string }>(
    `SELECT user_id FROM proof_participants WHERE proof_id = $1`,
    [proofId],
  );
  const pending = await db.query<{ invitee_user_id: string }>(
    `SELECT invitee_user_id
       FROM invitations
      WHERE proof_id = $1
        AND status = 'PENDING'
        AND invitee_user_id IS NOT NULL`,
    [proofId],
  );
  const participantIds = new Set(participants.rows.map((row) => row.user_id));
  const invitedIds = new Set(pending.rows.map((row) => row.invitee_user_id));

  return users.map((user) => ({
    ...user,
    invitationState: invitationStateForUser(user.userId, actorUserId, participantIds, invitedIds),
  }));
}

function invitationStateForUser(
  userId: string,
  actorUserId: string,
  participantIds: Set<string>,
  invitedIds: Set<string>,
): ProofInvitationState {
  if (userId === actorUserId) {
    return "SELF";
  }
  if (participantIds.has(userId)) {
    return "PARTICIPANT";
  }
  if (invitedIds.has(userId)) {
    return "INVITED";
  }
  return "NONE";
}

export async function createInvitation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: string | InvitationCreateInput,
): Promise<{ invitation: InvitationView; proof: ProofView }> {
  const { identifier, inviteeUserId } = resolveCreateInput(input);

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");

    if (inviteeUserId) {
      if (inviteeUserId === actorUserId) {
        throw new DomainError("CANNOT_INVITE_SELF", "cannot invite the current seller", 400);
      }
      const invitee = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1`,
        [inviteeUserId],
      );
      if (!invitee.rows[0]) {
        throw new DomainError("USER_NOT_FOUND", "Invitee user not found", 404);
      }
      const already = await tx.query<ParticipantRow>(
        `SELECT * FROM proof_participants WHERE proof_id = $1 AND user_id = $2`,
        [proofId, inviteeUserId],
      );
      if (already.rows[0]) {
        throw new DomainError(
          "ALREADY_PARTICIPANT",
          "Invitee is already a participant of this Proof",
          409,
        );
      }
    }

    const existing = inviteeUserId
      ? await tx.query<InvitationRow>(
          `SELECT * FROM invitations
            WHERE proof_id = $1 AND invitee_user_id = $2`,
          [proofId, inviteeUserId],
        )
      : await tx.query<InvitationRow>(
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
           id, proof_id, inviter_user_id, invitee_identifier, invitee_user_id,
           status, token, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)`,
        [
          invitationId,
          proofId,
          actorUserId,
          identifier,
          inviteeUserId,
          token,
          now.toISOString(),
          expiresAt.toISOString(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = inviteeUserId
          ? await tx.query<InvitationRow>(
              `SELECT * FROM invitations
                WHERE proof_id = $1 AND invitee_user_id = $2`,
              [proofId, inviteeUserId],
            )
          : await tx.query<InvitationRow>(
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

    // COUNTERPARTY_REQUIRED proofs start OPEN. Optional proofs are already
    // READY_FOR_EVIDENCE and must not be moved into AWAITING_PARTICIPANT.
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
      eventData: {
        invitationId,
        inviteeIdentifier: identifier,
        ...(inviteeUserId ? { inviteeUserId } : {}),
      },
      at: now,
    });

    return {
      invitation: toInvitationView({
        id: invitationId,
        proof_id: proofId,
        inviter_user_id: actorUserId,
        invitee_identifier: identifier,
        invitee_user_id: inviteeUserId,
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

function invitationLookupSql(ref: string): { sql: string; value: string } {
  if (ref.startsWith("inv_")) {
    return { sql: `SELECT * FROM invitations WHERE id = $1 FOR UPDATE`, value: ref };
  }
  return { sql: `SELECT * FROM invitations WHERE token = $1 FOR UPDATE`, value: ref };
}

export async function acceptInvitation(
  db: Database,
  clock: Clock,
  actorUserId: string,
  token: string,
): Promise<{ invitation: InvitationView; proof: ProofView }> {
  return db.transaction(async (tx) => {
    const lookup = invitationLookupSql(token);
    const found = await tx.query<InvitationRow>(lookup.sql, [lookup.value]);
    const invitation = found.rows[0];
    if (!invitation) {
      throw new DomainError("INVITATION_NOT_FOUND", "Invitation not found", 404);
    }

    if (invitation.invitee_user_id && invitation.invitee_user_id !== actorUserId) {
      throw new DomainError(
        "INVITATION_NOT_ADDRESSED",
        "Invitation is addressed to a different PackProof account",
        403,
      );
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

interface InboxRow {
  invitation_id: string;
  proof_id: string;
  status: InvitationStatus;
  created_at: Date | string;
  expires_at: Date | string | null;
  inviter_user_id: string;
  inviter_username: string | null;
  inviter_display_name: string | null;
  transaction_id: string;
  item_title: string | null;
  external_reference: string | null;
}

export async function listPendingInvitations(
  db: Database,
  actorUserId: string,
): Promise<InvitationInboxView[]> {
  const found = await db.query<InboxRow>(
    `SELECT
        i.id AS invitation_id,
        i.proof_id,
        i.status,
        i.created_at,
        i.expires_at,
        i.inviter_user_id,
        u.username AS inviter_username,
        u.display_name AS inviter_display_name,
        t.id AS transaction_id,
        t.item_title,
        t.external_reference
       FROM invitations i
       JOIN proofs p ON p.id = i.proof_id
       JOIN transactions t ON t.id = p.transaction_id
       JOIN users u ON u.id = i.inviter_user_id
      WHERE i.invitee_user_id = $1
        AND i.status = 'PENDING'
      ORDER BY i.created_at ASC, i.id ASC`,
    [actorUserId],
  );

  return found.rows.map((row) => ({
    invitationId: row.invitation_id,
    proofId: row.proof_id,
    status: row.status,
    createdAt: asRequiredIso(row.created_at),
    expiresAt: asIso(row.expires_at),
    inviter: {
      userId: row.inviter_user_id,
      username: row.inviter_username,
      displayName: row.inviter_display_name,
    },
    transaction: {
      transactionId: row.transaction_id,
      itemTitle: row.item_title,
      externalReference: row.external_reference,
    },
  }));
}
