import { randomBytes } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import {
  isMarketplaceProvider,
  requireOAuthProvider,
  requireOAuthPurpose,
  type OAuthAttemptPurpose,
} from "./identity-providers.js";

export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface OAuthAttemptView {
  attemptId: string;
  provider: string;
  purpose: OAuthAttemptPurpose;
  state: string;
  expiresAt: string;
}

export interface ConsumedOAuthAttempt {
  attemptId: string;
  provider: string;
  purpose: OAuthAttemptPurpose;
  userId: string | null;
  state: string;
  codeVerifier: string | null;
  redirectUri: string | null;
  metadata: Record<string, unknown>;
}

interface OAuthAttemptRow {
  id: string;
  provider: string;
  purpose: string;
  user_id: string | null;
  state: string;
  code_verifier: string | null;
  redirect_uri: string | null;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  created_at: Date | string;
  metadata: unknown;
}

export async function createOAuthAttempt(
  db: Database,
  clock: Clock,
  input: {
    provider: string;
    purpose: OAuthAttemptPurpose | string;
    userId?: string | null;
    redirectUri?: string | null;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<OAuthAttemptView> {
  const provider = requireOAuthProvider(input.provider);
  const purpose = requireOAuthPurpose(input.purpose);
  const userId = input.userId?.trim() || null;
  if ((purpose === "link" || purpose === "marketplace_connect") && !userId) {
    throw new DomainError(
      "UNAUTHENTICATED",
      "An authenticated PackProof session is required to connect this account",
      401,
    );
  }
  if (purpose === "authenticate" && isMarketplaceProvider(provider)) {
    throw new DomainError(
      "INVALID_OAUTH_PURPOSE",
      "Marketplace providers cannot authenticate PackProof users",
      400,
    );
  }
  if (purpose === "marketplace_connect" && !isMarketplaceProvider(provider)) {
    throw new DomainError(
      "INVALID_OAUTH_PURPOSE",
      "Only marketplace providers can use marketplace_connect",
      400,
    );
  }
  if ((purpose === "authenticate" || purpose === "link") && isMarketplaceProvider(provider)) {
    throw new DomainError(
      "INVALID_OAUTH_PURPOSE",
      "Marketplace providers are connected, not used as PackProof sign-in identities",
      400,
    );
  }

  const now = clock.now();
  const ttl = input.ttlMs ?? OAUTH_ATTEMPT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 30_000 || ttl > 30 * 60 * 1000) {
    throw new DomainError("INVALID_OAUTH_ATTEMPT", "OAuth attempt lifetime is invalid", 400);
  }
  const id = newId("oa");
  const state = randomBytes(32).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  await db.query(
    `INSERT INTO oauth_authorization_attempts (
       id, provider, purpose, user_id, state, code_verifier, redirect_uri,
       expires_at, created_at, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      id,
      provider,
      purpose,
      userId,
      state,
      codeVerifier,
      normalizeRedirectUri(input.redirectUri),
      expiresAt,
      now.toISOString(),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return {
    attemptId: id,
    provider,
    purpose,
    state,
    expiresAt,
  };
}

export async function consumeOAuthAttempt(
  db: Database,
  clock: Clock,
  stateRaw: unknown,
): Promise<ConsumedOAuthAttempt> {
  if (typeof stateRaw !== "string" || !stateRaw.trim()) {
    throw new DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", 400);
  }
  const state = stateRaw.trim();
  return db.transaction(async (tx) => {
    const found = await tx.query<OAuthAttemptRow>(
      `SELECT * FROM oauth_authorization_attempts WHERE state = $1 FOR UPDATE`,
      [state],
    );
    const row = found.rows[0];
    if (!row) {
      throw new DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", 400);
    }
    if (row.consumed_at) {
      throw new DomainError("OAUTH_STATE_REUSED", "OAuth state has already been used", 409);
    }
    if (new Date(row.expires_at).getTime() <= clock.now().getTime()) {
      throw new DomainError("OAUTH_STATE_EXPIRED", "OAuth authorization attempt expired", 400);
    }
    await tx.query(
      `UPDATE oauth_authorization_attempts SET consumed_at = $2 WHERE id = $1`,
      [row.id, clock.now().toISOString()],
    );
    return {
      attemptId: row.id,
      provider: row.provider,
      purpose: requireOAuthPurpose(row.purpose),
      userId: row.user_id,
      state: row.state,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      metadata: asMetadata(row.metadata),
    };
  });
}

function normalizeRedirectUri(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_OAUTH_ATTEMPT", "redirect URI must be a string", 400);
  }
  const raw = value.trim();
  if (!raw || raw.length > 500) {
    throw new DomainError("INVALID_OAUTH_ATTEMPT", "redirect URI is invalid", 400);
  }
  return raw;
}

function asMetadata(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return asMetadata(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
