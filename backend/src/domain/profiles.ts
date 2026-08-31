import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso } from "./types.js";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 64;
export const SEARCH_MAX_RESULTS = 20;

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._]{2,23}$/;
const DISPLAY_NAME_MAX_LENGTH = 80;

export interface ProfileView {
  userId: string;
  username: string | null;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicProfileView {
  userId: string;
  username: string;
  displayName: string | null;
}

interface UserProfileRow {
  id: string;
  username: string | null;
  username_normalized: string | null;
  display_name: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseUsername(raw: unknown): { username: string; normalized: string } {
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_USERNAME", "username is required", 400);
  }
  const username = raw.trim();
  if (!username) {
    throw new DomainError("INVALID_USERNAME", "username is required", 400);
  }
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    throw new DomainError(
      "INVALID_USERNAME",
      `username must be ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters`,
      400,
    );
  }
  if (/\s/.test(username) || /[\\/]/.test(username) || /[\u0000-\u001F\u007F]/.test(username)) {
    throw new DomainError("INVALID_USERNAME", "username contains invalid characters", 400);
  }
  if (!USERNAME_PATTERN.test(username) || username.includes("..") || username.endsWith(".")) {
    throw new DomainError("INVALID_USERNAME", "username contains invalid characters", 400);
  }
  return { username, normalized: normalizeUsername(username) };
}

export function parseDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_DISPLAY_NAME", "displayName is required", 400);
  }
  const displayName = raw.trim();
  if (!displayName) {
    throw new DomainError("INVALID_DISPLAY_NAME", "displayName is required", 400);
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new DomainError(
      "INVALID_DISPLAY_NAME",
      `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      400,
    );
  }
  if (/[\u0000-\u001F\u007F]/.test(displayName)) {
    throw new DomainError("INVALID_DISPLAY_NAME", "displayName contains invalid characters", 400);
  }
  return displayName;
}

function toProfileView(row: UserProfileRow): ProfileView {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
  };
}

export async function getProfile(db: Database, userId: string): Promise<ProfileView> {
  const found = await db.query<UserProfileRow>(
    `SELECT id, username, username_normalized, display_name, status, created_at, updated_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!found.rows[0]) {
    throw new DomainError("USER_NOT_FOUND", "User not found", 404);
  }
  return toProfileView(found.rows[0]);
}

export async function updateProfile(
  db: Database,
  clock: Clock,
  userId: string,
  input: { username?: unknown; displayName?: unknown },
): Promise<ProfileView> {
  const hasUsername = input.username !== undefined;
  const hasDisplayName = input.displayName !== undefined;
  if (!hasUsername && !hasDisplayName) {
    throw new DomainError("INVALID_PROFILE", "username or displayName is required", 400);
  }

  const username = hasUsername && input.username != null ? parseUsername(input.username) : null;
  const displayName =
    hasDisplayName && input.displayName != null ? parseDisplayName(input.displayName) : null;

  return db.transaction(async (tx) => {
    const found = await tx.query<UserProfileRow>(
      `SELECT id, username, username_normalized, display_name, status, created_at, updated_at
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = found.rows[0];
    if (!row) {
      throw new DomainError("USER_NOT_FOUND", "User not found", 404);
    }

    if (username && row.username_normalized && row.username_normalized !== username.normalized) {
      throw new DomainError("USERNAME_IMMUTABLE", "username cannot be changed", 409);
    }

    const nextUsername = username?.username ?? row.username;
    const nextNormalized = username?.normalized ?? row.username_normalized;
    const nextDisplayName = displayName ?? row.display_name;
    const now = clock.now().toISOString();

    try {
      await tx.query(
        `UPDATE users
            SET username = $2,
                username_normalized = $3,
                display_name = $4,
                updated_at = $5
          WHERE id = $1`,
        [userId, nextUsername, nextNormalized, nextDisplayName, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError("USERNAME_TAKEN", "username is already taken", 409);
      }
      throw error;
    }

    return getProfile(tx, userId);
  });
}

export function normalizeSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new DomainError("INVALID_SEARCH", "q is required", 400);
  }
  const query = raw.trim().replace(/^@+/, "").trim().toLowerCase();
  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    throw new DomainError(
      "INVALID_SEARCH",
      `q must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`,
      400,
    );
  }
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new DomainError(
      "INVALID_SEARCH",
      `q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters`,
      400,
    );
  }
  return query;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function searchUsers(
  db: Database,
  rawQuery: unknown,
): Promise<PublicProfileView[]> {
  const query = normalizeSearchQuery(rawQuery);
  const escaped = escapeLike(query);
  const prefix = `${escaped}%`;
  const displayContains = `%${escaped}%`;

  const found = await db.query<UserProfileRow>(
    `SELECT id, username, username_normalized, display_name, status, created_at, updated_at
       FROM users
      WHERE username_normalized IS NOT NULL
        AND username IS NOT NULL
        AND status = 'ACTIVE'
        AND (
          username_normalized = $1
          OR username_normalized LIKE $2 ESCAPE '\\'
          OR lower(coalesce(display_name, '')) LIKE $2 ESCAPE '\\'
          OR lower(coalesce(display_name, '')) LIKE $3 ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN username_normalized = $1 THEN 0
          WHEN username_normalized LIKE $2 ESCAPE '\\' THEN 1
          WHEN lower(coalesce(display_name, '')) LIKE $2 ESCAPE '\\' THEN 2
          ELSE 3
        END,
        username_normalized ASC,
        id ASC
      LIMIT $4`,
    [query, prefix, displayContains, SEARCH_MAX_RESULTS],
  );

  return found.rows.map((row) => ({
    userId: row.id,
    username: row.username as string,
    displayName: row.display_name,
  }));
}
