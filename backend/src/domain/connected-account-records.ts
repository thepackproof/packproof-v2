import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import {
  requireConnectedAccountProvider,
  type ConnectedAccountProviderId,
} from "./identity-providers.js";
import { asRequiredIso } from "./types.js";
import type { ConnectedAccountStatus } from "../integrations/connected-accounts/types.js";

export interface ConnectedAccountRow {
  id: string;
  user_id: string;
  provider: string;
  external_account_id: string;
  external_account_name: string | null;
  status: ConnectedAccountStatus | string;
  scopes: unknown;
  credential_reference: string;
  expires_at: Date | string | null;
  provider_metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  disconnected_at: Date | string | null;
}

export interface ConnectedAccountRecord {
  id: string;
  userId: string;
  provider: ConnectedAccountProviderId;
  externalAccountId: string;
  externalAccountName: string | null;
  status: ConnectedAccountStatus;
  scopes: string[];
  credentialReference: string;
  expiresAt: string | null;
  providerMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export async function insertConnectedAccount(
  db: Database,
  clock: Clock,
  input: {
    id?: string;
    userId: string;
    provider: string;
    externalAccountId: string;
    externalAccountName?: string | null;
    status?: ConnectedAccountStatus;
    scopes?: string[];
    credentialReference: string;
    expiresAt?: string | null;
    providerMetadata?: Record<string, unknown>;
  },
): Promise<ConnectedAccountRecord> {
  const id = input.id ?? newId("cac");
  const now = clock.now().toISOString();
  const provider = requireConnectedAccountProvider(input.provider);
  try {
    await db.query(
      `INSERT INTO connected_accounts (
         id, user_id, provider, external_account_id, external_account_name, status,
         scopes, credential_reference, expires_at, provider_metadata, created_at, updated_at,
         disconnected_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $11, $12)`,
      [
        id,
        input.userId,
        provider,
        input.externalAccountId,
        input.externalAccountName ?? null,
        input.status ?? "CONNECTED",
        JSON.stringify(input.scopes ?? []),
        input.credentialReference,
        input.expiresAt ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        now,
        input.status === "DISCONNECTED" ? now : null,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError(
        "CONNECTED_ACCOUNT_ALREADY_LINKED",
        "This external account is already connected",
        409,
      );
    }
    throw error;
  }
  return loadConnectedAccount(db, id);
}

export async function loadConnectedAccount(
  db: Database,
  id: string,
): Promise<ConnectedAccountRecord> {
  const found = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts WHERE id = $1`,
    [id],
  );
  const row = found.rows[0];
  if (!row) {
    throw new DomainError("CONNECTED_ACCOUNT_NOT_FOUND", "No connected account was found", 404);
  }
  return toRecord(row);
}

export async function findOwnedConnectedAccount(
  db: Database,
  userId: string,
  id: string,
): Promise<ConnectedAccountRecord | null> {
  const found = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return found.rows[0] ? toRecord(found.rows[0]) : null;
}

export async function findConnectedAccountByExternal(
  db: Database,
  provider: string,
  externalAccountId: string,
): Promise<ConnectedAccountRecord | null> {
  const found = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts
      WHERE provider = $1 AND external_account_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [requireConnectedAccountProvider(provider), externalAccountId],
  );
  return found.rows[0] ? toRecord(found.rows[0]) : null;
}

export async function findOwnedByProviderExternal(
  db: Database,
  userId: string,
  provider: string,
  externalAccountId: string,
): Promise<ConnectedAccountRecord | null> {
  const found = await db.query<ConnectedAccountRow>(
    `SELECT * FROM connected_accounts
      WHERE user_id = $1 AND provider = $2 AND external_account_id = $3
      LIMIT 1`,
    [userId, requireConnectedAccountProvider(provider), externalAccountId],
  );
  return found.rows[0] ? toRecord(found.rows[0]) : null;
}

export async function listOwnedConnectedAccounts(
  db: Database,
  userId: string,
  options: { includeDisconnected?: boolean } = {},
): Promise<ConnectedAccountRecord[]> {
  const found = await db.query<ConnectedAccountRow>(
    options.includeDisconnected
      ? `SELECT * FROM connected_accounts WHERE user_id = $1 ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM connected_accounts
          WHERE user_id = $1 AND status <> 'DISCONNECTED'
          ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return found.rows.map(toRecord);
}

export async function updateConnectedAccount(
  db: Database,
  clock: Clock,
  id: string,
  patch: {
    externalAccountId?: string;
    externalAccountName?: string | null;
    status?: ConnectedAccountStatus;
    scopes?: string[];
    credentialReference?: string;
    expiresAt?: string | null;
    providerMetadata?: Record<string, unknown>;
  },
): Promise<ConnectedAccountRecord> {
  const current = await loadConnectedAccount(db, id);
  const status = patch.status ?? current.status;
  const disconnectedAt =
    status === "DISCONNECTED" ? (current.disconnectedAt ?? clock.now().toISOString()) : null;
  await db.query(
    `UPDATE connected_accounts
        SET external_account_id = $2,
            external_account_name = $3,
            status = $4,
            scopes = $5::jsonb,
            credential_reference = $6,
            expires_at = $7,
            provider_metadata = $8::jsonb,
            updated_at = $9,
            disconnected_at = $10
      WHERE id = $1`,
    [
      id,
      patch.externalAccountId ?? current.externalAccountId,
      patch.externalAccountName === undefined
        ? current.externalAccountName
        : patch.externalAccountName,
      status,
      JSON.stringify(patch.scopes ?? current.scopes),
      patch.credentialReference ?? current.credentialReference,
      patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      JSON.stringify(patch.providerMetadata ?? current.providerMetadata),
      clock.now().toISOString(),
      disconnectedAt,
    ],
  );
  return loadConnectedAccount(db, id);
}

export async function upsertConnectedAccount(
  db: Database,
  clock: Clock,
  input: {
    id?: string;
    userId: string;
    provider: string;
    externalAccountId: string;
    externalAccountName?: string | null;
    scopes?: string[];
    credentialReference: string;
    expiresAt?: string | null;
    providerMetadata?: Record<string, unknown>;
  },
): Promise<{ record: ConnectedAccountRecord; created: boolean }> {
  const existingOther = await findConnectedAccountByExternal(
    db,
    input.provider,
    input.externalAccountId,
  );
  if (existingOther && existingOther.userId !== input.userId && existingOther.status !== "DISCONNECTED") {
    throw new DomainError(
      "CONNECTED_ACCOUNT_ALREADY_LINKED",
      "This external account is already connected to another PackProof user",
      409,
    );
  }
  const owned = await findOwnedByProviderExternal(
    db,
    input.userId,
    input.provider,
    input.externalAccountId,
  );
  const reuse = owned ?? (existingOther?.userId === input.userId ? existingOther : null);
  if (reuse) {
    const record = await updateConnectedAccount(db, clock, reuse.id, {
      externalAccountId: input.externalAccountId,
      externalAccountName: input.externalAccountName ?? null,
      status: "CONNECTED",
      scopes: input.scopes ?? reuse.scopes,
      credentialReference: input.credentialReference,
      expiresAt: input.expiresAt ?? null,
      providerMetadata: {
        ...reuse.providerMetadata,
        ...(input.providerMetadata ?? {}),
      },
    });
    return { record, created: false };
  }
  const record = await insertConnectedAccount(db, clock, input);
  return { record, created: true };
}

export function toRecord(row: ConnectedAccountRow): ConnectedAccountRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: requireConnectedAccountProvider(row.provider),
    externalAccountId: row.external_account_id,
    externalAccountName: row.external_account_name,
    status: row.status as ConnectedAccountStatus,
    scopes: asStringArray(row.scopes),
    credentialReference: row.credential_reference,
    expiresAt: row.expires_at ? asRequiredIso(row.expires_at) : null,
    providerMetadata: asObject(row.provider_metadata),
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    disconnectedAt: row.disconnected_at ? asRequiredIso(row.disconnected_at) : null,
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    try {
      return asStringArray(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
