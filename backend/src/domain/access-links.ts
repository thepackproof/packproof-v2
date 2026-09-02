import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import { asIso, asRequiredIso } from "./types.js";
import { requireParticipant } from "./proof-access.js";
import { requireAccessLinkScope, type AccessLinkScope } from "./workflow.js";

export interface ProofAccessLinkRow {
  id: string;
  proof_id: string;
  token_hash: string;
  scope: AccessLinkScope | string;
  created_by_participant_id: string;
  recipient_hint: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  last_accessed_at: Date | string | null;
  view_count: number | string;
}

export interface AccessLinkView {
  accessLinkId: string;
  proofId: string;
  scope: string;
  recipientHint: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  viewCount: number;
}

export interface CreatedAccessLink extends AccessLinkView {
  token: string;
  url: string;
}

export function toAccessLinkView(row: ProofAccessLinkRow): AccessLinkView {
  return {
    accessLinkId: row.id,
    proofId: row.proof_id,
    scope: row.scope,
    recipientHint: row.recipient_hint,
    createdAt: asRequiredIso(row.created_at),
    expiresAt: asIso(row.expires_at),
    revokedAt: asIso(row.revoked_at),
    lastAccessedAt: asIso(row.last_accessed_at),
    viewCount: Number(row.view_count ?? 0),
  };
}

export async function listAccessLinks(
  db: Database,
  actorUserId: string,
  proofId: string,
): Promise<AccessLinkView[]> {
  await requireParticipant(db, proofId, actorUserId);
  const found = await db.query<ProofAccessLinkRow>(
    `SELECT * FROM proof_access_links WHERE proof_id = $1 ORDER BY created_at DESC, id DESC`,
    [proofId],
  );
  return found.rows.map(toAccessLinkView);
}

export async function createAccessLink(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    scope?: unknown;
    expiresAt?: unknown;
    recipientHint?: unknown;
    publicWebBaseUrl: string;
  },
): Promise<CreatedAccessLink> {
  const scope = requireAccessLinkScope(input.scope);
  const recipientHint = normalizeHint(input.recipientHint);
  const expiresAt = parseExpiresAt(input.expiresAt);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  return db.transaction(async (tx) => {
    const participant = await requireParticipant(tx, proofId, actorUserId);
    const id = newId("pal");
    const now = clock.now();
    await tx.query(
      `INSERT INTO proof_access_links (
         id, proof_id, token_hash, scope, created_by_participant_id, recipient_hint,
         created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        proofId,
        tokenHash,
        scope,
        participant.id,
        recipientHint,
        now.toISOString(),
        expiresAt,
      ],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_ACCESS_LINK_CREATED",
      eventData: { accessLinkId: id, scope, expiresAt, recipientHint },
      at: now,
    });
    const url = `${input.publicWebBaseUrl.replace(/\/$/, "")}/p/${token}`;
    return {
      ...toAccessLinkView({
        id,
        proof_id: proofId,
        token_hash: tokenHash,
        scope,
        created_by_participant_id: participant.id,
        recipient_hint: recipientHint,
        created_at: now.toISOString(),
        expires_at: expiresAt,
        revoked_at: null,
        last_accessed_at: null,
        view_count: 0,
      }),
      token,
      url,
    };
  });
}

export async function revokeAccessLink(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  linkId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireParticipant(tx, proofId, actorUserId);
    const found = await tx.query<ProofAccessLinkRow>(
      `SELECT * FROM proof_access_links WHERE id = $1 AND proof_id = $2 FOR UPDATE`,
      [linkId, proofId],
    );
    const row = found.rows[0];
    if (!row) {
      throw new DomainError("ACCESS_LINK_NOT_FOUND", "Access link not found", 404);
    }
    if (row.revoked_at) {
      return;
    }
    const now = clock.now();
    await tx.query(
      `UPDATE proof_access_links SET revoked_at = $2 WHERE id = $1`,
      [linkId, now.toISOString()],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_ACCESS_LINK_REVOKED",
      eventData: { accessLinkId: linkId },
      at: now,
    });
  });
}

export async function resolveAccessToken(
  db: Database,
  clock: Clock,
  token: string,
): Promise<ProofAccessLinkRow> {
  const presented = token.trim();
  if (!presented || presented.length < 16) {
    throw new DomainError("ACCESS_LINK_INVALID", "This viewing link is not valid", 404);
  }
  const tokenHash = sha256Hex(presented);
  const found = await db.query<ProofAccessLinkRow>(
    `SELECT * FROM proof_access_links WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = found.rows[0];
  if (!row || !hashesMatch(row.token_hash, tokenHash)) {
    throw new DomainError("ACCESS_LINK_INVALID", "This viewing link is not valid", 404);
  }
  const now = clock.now();
  if (row.revoked_at) {
    throw new DomainError("ACCESS_LINK_REVOKED", "This viewing link has been revoked", 404);
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new DomainError("ACCESS_LINK_EXPIRED", "This viewing link has expired", 404);
  }
  const firstView = !row.last_accessed_at;
  await db.query(
    `UPDATE proof_access_links
        SET last_accessed_at = $2, view_count = view_count + 1
      WHERE id = $1`,
    [row.id, now.toISOString()],
  );
  if (firstView) {
    await appendAudit(db, {
      proofId: row.proof_id,
      actorUserId: null,
      eventType: "PROOF_VIEWED_VIA_ACCESS_LINK",
      eventData: { accessLinkId: row.id, scope: row.scope },
      at: now,
    });
  }
  return row;
}

function hashesMatch(stored: string, computed: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(computed, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function normalizeHint(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_ACCESS_LINK", "recipientHint must be a string", 400);
  }
  const hint = value.trim();
  if (hint.length > 200) {
    throw new DomainError("INVALID_ACCESS_LINK", "recipientHint is too long", 400);
  }
  return hint || null;
}

function parseExpiresAt(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_ACCESS_LINK", "expiresAt must be an ISO timestamp", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError("INVALID_ACCESS_LINK", "expiresAt must be an ISO timestamp", 400);
  }
  return parsed.toISOString();
}

const WINDOW_MS = 60_000;
const LIMIT = 60;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function assertPublicProofRateLimit(key: string): void {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count > LIMIT) {
    throw new DomainError("RATE_LIMITED", "Too many viewing requests. Try again shortly.", 429);
  }
}
