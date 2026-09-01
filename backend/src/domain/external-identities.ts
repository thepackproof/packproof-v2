import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { requireAuthIdentityProvider, type AuthIdentityProvider } from "./identity-providers.js";
import { asRequiredIso } from "./types.js";

const SUBJECT_MAX = 200;
const HANDLE_MAX = 80;
const DISPLAY_NAME_MAX = 80;
const AVATAR_URL_MAX = 500;
const METADATA_MAX_BYTES = 2048;

export interface LinkedIdentityView {
  provider: AuthIdentityProvider | string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  canAuthenticate: boolean;
  visibleOnProfile: boolean;
  searchable: boolean;
  linkedAt: string;
  lastRefreshedAt: string | null;
}

export interface VerifiedProviderIdentity {
  provider: string;
  providerSubject: string;
  providerHandle?: string | null;
  providerDisplayName?: string | null;
  avatarUrl?: string | null;
  canAuthenticate?: boolean;
  visibleOnProfile?: boolean;
  searchable?: boolean;
  metadata?: Record<string, unknown>;
}

interface AuthIdentityRow {
  id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  provider_handle: string | null;
  provider_display_name: string | null;
  avatar_url: string | null;
  last_refreshed_at: Date | string | null;
  can_authenticate: boolean | string | number;
  visible_on_profile: boolean | string | number;
  searchable: boolean | string | number;
  metadata: unknown;
  created_at: Date | string;
}

export async function findUserIdByProviderSubject(
  db: Database,
  provider: string,
  providerSubject: string,
): Promise<string | null> {
  const normalizedProvider = requireAuthIdentityProvider(provider);
  const subject = normalizeProviderSubject(providerSubject);
  const found = await db.query<{ user_id: string }>(
    `SELECT user_id FROM auth_identities
      WHERE provider = $1 AND provider_subject = $2`,
    [normalizedProvider, subject],
  );
  return found.rows[0]?.user_id ?? null;
}

export async function listLinkedIdentities(
  db: Database,
  userId: string,
): Promise<LinkedIdentityView[]> {
  const found = await db.query<AuthIdentityRow>(
    `SELECT id, user_id, provider, provider_subject, provider_handle, provider_display_name,
            avatar_url, last_refreshed_at, can_authenticate, visible_on_profile, searchable,
            metadata, created_at
       FROM auth_identities
      WHERE user_id = $1
      ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return found.rows.map(toPublicView);
}

export async function linkVerifiedIdentity(
  db: Database,
  clock: Clock,
  userId: string,
  identity: VerifiedProviderIdentity,
): Promise<LinkedIdentityView> {
  const provider = requireAuthIdentityProvider(identity.provider);
  const providerSubject = normalizeProviderSubject(identity.providerSubject);
  const handle = normalizeHandle(identity.providerHandle);
  const displayName = normalizeOptionalName(identity.providerDisplayName);
  const avatarUrl = normalizeAvatarUrl(identity.avatarUrl);
  const canAuthenticate = identity.canAuthenticate !== false;
  const visibleOnProfile = identity.visibleOnProfile === true;
  const searchable = identity.searchable === true;
  const metadata = normalizeMetadata(identity.metadata);
  const now = clock.now().toISOString();

  return db.transaction(async (tx) => {
    const bySubject = await tx.query<AuthIdentityRow>(
      `SELECT * FROM auth_identities
        WHERE provider = $1 AND provider_subject = $2
        FOR UPDATE`,
      [provider, providerSubject],
    );
    const existingSubject = bySubject.rows[0];
    if (existingSubject && existingSubject.user_id !== userId) {
      throw new DomainError(
        "IDENTITY_ALREADY_LINKED",
        "This identity is already linked to another PackProof account",
        409,
      );
    }

    const byUserProvider = await tx.query<AuthIdentityRow>(
      `SELECT * FROM auth_identities
        WHERE user_id = $1 AND provider = $2
        FOR UPDATE`,
      [userId, provider],
    );
    const existingProvider = byUserProvider.rows[0];
    if (existingProvider && existingProvider.provider_subject !== providerSubject) {
      throw new DomainError(
        "IDENTITY_PROVIDER_ALREADY_LINKED",
        "This PackProof account already has a linked identity for that provider",
        409,
      );
    }

    if (existingSubject) {
      await tx.query(
        `UPDATE auth_identities
            SET provider_handle = $2,
                provider_display_name = $3,
                avatar_url = $4,
                last_refreshed_at = $5,
                can_authenticate = $6,
                visible_on_profile = $7,
                searchable = $8,
                metadata = $9::jsonb
          WHERE id = $1`,
        [
          existingSubject.id,
          handle,
          displayName,
          avatarUrl,
          now,
          canAuthenticate,
          visibleOnProfile,
          searchable,
          JSON.stringify(metadata),
        ],
      );
      return getLinkedIdentity(tx, existingSubject.id);
    }

    const id = newId("idt");
    try {
      await tx.query(
        `INSERT INTO auth_identities (
           id, user_id, provider, provider_subject, provider_handle, provider_display_name,
           avatar_url, last_refreshed_at, can_authenticate, visible_on_profile, searchable,
           metadata, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $8)`,
        [
          id,
          userId,
          provider,
          providerSubject,
          handle,
          displayName,
          avatarUrl,
          now,
          canAuthenticate,
          visibleOnProfile,
          searchable,
          JSON.stringify(metadata),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "IDENTITY_ALREADY_LINKED",
          "This identity is already linked to another PackProof account",
          409,
        );
      }
      throw error;
    }
    return getLinkedIdentity(tx, id);
  });
}

export async function unlinkIdentity(
  db: Database,
  userId: string,
  providerRaw: unknown,
): Promise<void> {
  const provider = requireAuthIdentityProvider(providerRaw);
  await db.transaction(async (tx) => {
    const found = await tx.query<AuthIdentityRow>(
      `SELECT * FROM auth_identities
        WHERE user_id = $1 AND provider = $2
        FOR UPDATE`,
      [userId, provider],
    );
    const row = found.rows[0];
    if (!row) {
      throw new DomainError("IDENTITY_NOT_LINKED", "That identity is not linked", 404);
    }
    if (asBoolean(row.can_authenticate)) {
      const remaining = await tx.query<{ count: string | number }>(
        `SELECT count(*)::int AS count
           FROM auth_identities
          WHERE user_id = $1 AND can_authenticate = TRUE`,
        [userId],
      );
      const count = Number(remaining.rows[0]?.count ?? 0);
      if (count <= 1) {
        throw new DomainError(
          "AUTH_METHOD_REQUIRED",
          "Cannot unlink the only remaining sign-in method",
          409,
        );
      }
    }
    await tx.query(`DELETE FROM auth_identities WHERE id = $1`, [row.id]);
  });
}

async function getLinkedIdentity(db: Database, id: string): Promise<LinkedIdentityView> {
  const found = await db.query<AuthIdentityRow>(
    `SELECT * FROM auth_identities WHERE id = $1`,
    [id],
  );
  if (!found.rows[0]) {
    throw new DomainError("IDENTITY_NOT_LINKED", "That identity is not linked", 404);
  }
  return toPublicView(found.rows[0]);
}

function toPublicView(row: AuthIdentityRow): LinkedIdentityView {
  return {
    provider: row.provider,
    handle: row.provider_handle,
    displayName: row.provider_display_name,
    avatarUrl: row.avatar_url,
    canAuthenticate: asBoolean(row.can_authenticate),
    visibleOnProfile: asBoolean(row.visible_on_profile),
    searchable: asBoolean(row.searchable),
    linkedAt: asRequiredIso(row.created_at),
    lastRefreshedAt: row.last_refreshed_at ? asRequiredIso(row.last_refreshed_at) : null,
  };
}

function normalizeProviderSubject(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_PROVIDER_SUBJECT", "provider subject is required", 400);
  }
  const subject = value.trim();
  if (!subject) {
    throw new DomainError("INVALID_PROVIDER_SUBJECT", "provider subject is required", 400);
  }
  if (subject.length > SUBJECT_MAX) {
    throw new DomainError("INVALID_PROVIDER_SUBJECT", "provider subject is too long", 400);
  }
  if (/[\u0000-\u001F\u007F]/.test(subject)) {
    throw new DomainError("INVALID_PROVIDER_SUBJECT", "provider subject is invalid", 400);
  }
  return subject;
}

function normalizeHandle(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_PROVIDER_HANDLE", "provider handle must be a string", 400);
  }
  const handle = value.trim().replace(/^@+/, "");
  if (!handle) {
    return null;
  }
  if (handle.length > HANDLE_MAX || /[\u0000-\u001F\u007F\s]/.test(handle)) {
    throw new DomainError("INVALID_PROVIDER_HANDLE", "provider handle is invalid", 400);
  }
  return handle;
}

function normalizeOptionalName(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_DISPLAY_NAME", "display name must be a string", 400);
  }
  const name = value.trim();
  if (!name) {
    return null;
  }
  if (name.length > DISPLAY_NAME_MAX || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new DomainError("INVALID_DISPLAY_NAME", "display name is invalid", 400);
  }
  return name;
}

function normalizeAvatarUrl(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_AVATAR_URL", "avatar URL must be a string", 400);
  }
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  if (raw.length > AVATAR_URL_MAX) {
    throw new DomainError("INVALID_AVATAR_URL", "avatar URL is too long", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DomainError("INVALID_AVATAR_URL", "avatar URL is invalid", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new DomainError("INVALID_AVATAR_URL", "avatar URL must be https", 400);
  }
  if (parsed.username || parsed.password) {
    throw new DomainError("INVALID_AVATAR_URL", "avatar URL is invalid", 400);
  }
  return parsed.toString();
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_IDENTITY_METADATA", "metadata must be an object", 400);
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > METADATA_MAX_BYTES) {
    throw new DomainError("INVALID_IDENTITY_METADATA", "metadata is too large", 400);
  }
  return value as Record<string, unknown>;
}

function asBoolean(value: boolean | string | number): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}
