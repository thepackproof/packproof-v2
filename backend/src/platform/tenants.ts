import { randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
import { newId } from "../ids.js";
import { sha256Hex } from "../hash.js";

export const API_SCOPES = [
  "proofs:read",
  "proofs:write",
  "evidence:write",
  "participants:write",
  "attestations:write",
  "proofs:finalize",
  "events:read",
  "webhooks:manage",
  "intake:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export interface ApiPrincipal {
  tenantId: string;
  keyId: string;
  userId: string;
  environment: "sandbox" | "live";
  scopes: ApiScope[];
}

export function textField(value: unknown, name: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new DomainError("INVALID_REQUEST", `${name} must contain 1–${max} characters`, 400);
  }
  return value.trim();
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("INVALID_REQUEST", "A JSON object is required", 400);
  return value as Record<string, unknown>;
}
export async function requireTenantOwner(db: Database, userId: string, tenantId: string) {
  const found = await db.query<{ id: string; environment: "sandbox" | "live" }>(
    "SELECT id, environment FROM api_tenants WHERE id = $1 AND owner_user_id = $2",
    [tenantId, userId],
  );
  if (!found.rows[0]) throw new DomainError("TENANT_NOT_FOUND", "Tenant not found", 404);
  return found.rows[0];
}
export async function createTenant(db: Database, clock: Clock, userId: string, input: unknown) {
  const body = record(input);
  const name = textField(body.name, "name", 80);
  const environment = body.environment ?? "sandbox";
  if (environment !== "sandbox" && environment !== "live")
    throw new DomainError("INVALID_REQUEST", "environment must be sandbox or live", 400);
  return db.transaction(async (tx) => {
    const result = await tx.query(
      `INSERT INTO api_tenants (id, owner_user_id, name, environment, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_user_id, name, environment) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, environment, created_at AS "createdAt"`,
      [newId("ten"), userId, name, environment, clock.now().toISOString()],
    );
    await managementAudit(
      tx,
      clock,
      userId,
      String(result.rows[0].id),
      null,
      "TENANT_CREATED_OR_FOUND",
      201,
    );
    return result.rows[0];
  });
}
export async function issueApiKey(
  db: Database,
  clock: Clock,
  userId: string,
  tenantId: string,
  input: unknown,
) {
  const tenant = await requireTenantOwner(db, userId, tenantId);
  const body = record(input);
  const name = textField(body.name, "name", 80);
  if (
    !Array.isArray(body.scopes) ||
    body.scopes.length === 0 ||
    body.scopes.some((s) => !API_SCOPES.includes(s as ApiScope))
  ) {
    throw new DomainError("INVALID_SCOPES", "Select one or more documented API scopes", 400);
  }
  const scopes = [...new Set(body.scopes as ApiScope[])];
  const token = `pp_${tenant.environment}_${randomBytes(32).toString("base64url")}`;
  const id = newId("key");
  const prefix = token.slice(0, 20);
  return db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO api_keys (id,tenant_id,name,token_hash,prefix,scopes,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        id,
        tenantId,
        name,
        sha256Hex(token),
        prefix,
        JSON.stringify(scopes),
        clock.now().toISOString(),
      ],
    );
    await managementAudit(tx, clock, userId, tenantId, id, "API_KEY_ISSUED", 201);
    return { id, name, prefix, scopes, token };
  });
}
export async function revokeApiKey(
  db: Database,
  clock: Clock,
  userId: string,
  tenantId: string,
  keyId: string,
) {
  await requireTenantOwner(db, userId, tenantId);
  await db.transaction(async (tx) => {
    const result = await tx.query(
      "UPDATE api_keys SET revoked_at = COALESCE(revoked_at,$3) WHERE id=$1 AND tenant_id=$2 RETURNING id",
      [keyId, tenantId, clock.now().toISOString()],
    );
    if (!result.rows[0]) throw new DomainError("KEY_NOT_FOUND", "API key not found", 404);
    await managementAudit(tx, clock, userId, tenantId, keyId, "API_KEY_REVOKED", 204);
  });
}
async function managementAudit(
  db: Database,
  clock: Clock,
  userId: string,
  tenantId: string,
  keyId: string | null,
  operation: string,
  status: number,
) {
  await db.query(
    "INSERT INTO api_request_audit(id,tenant_id,key_id,actor_user_id,operation,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [newId("req"), tenantId, keyId, userId, operation, status, clock.now().toISOString()],
  );
}
export async function authenticateApiKey(
  db: Database,
  authorization: string | undefined,
): Promise<ApiPrincipal> {
  const token = authorization?.match(/^Bearer (pp_(?:sandbox|live)_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new DomainError("UNAUTHENTICATED", "A PackProof API key is required", 401);
  const found = await db.query<ApiPrincipal>(
    `SELECT k.id AS "keyId", k.tenant_id AS "tenantId", t.owner_user_id AS "userId", t.environment, k.scopes
    FROM api_keys k JOIN api_tenants t ON t.id = k.tenant_id WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
    [sha256Hex(token)],
  );
  if (!found.rows[0]) throw new DomainError("UNAUTHENTICATED", "Invalid or revoked API key", 401);
  return found.rows[0];
}
export function requireScope(principal: ApiPrincipal, scope: ApiScope) {
  if (!principal.scopes.includes(scope))
    throw new DomainError("INSUFFICIENT_SCOPE", `Required scope: ${scope}`, 403);
}
export async function requireTenantProof(db: Database, principal: ApiPrincipal, proofId: string) {
  const found = await db.query<{ external_id: string }>(
    "SELECT external_id FROM api_tenant_proofs WHERE tenant_id=$1 AND proof_id=$2",
    [principal.tenantId, proofId],
  );
  if (!found.rows[0]) throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  return found.rows[0];
}
export async function consumeApiRate(db: Database, clock: Clock, tenantId: string, limit = 120) {
  const start = Math.floor(clock.now().getTime() / 60000);
  const result = await db.query<{ request_count: number }>(
    `INSERT INTO api_rate_windows (tenant_id,window_start,request_count) VALUES ($1,$2,1)
    ON CONFLICT (tenant_id) DO UPDATE SET window_start=$2, request_count=CASE WHEN api_rate_windows.window_start=$2 THEN api_rate_windows.request_count+1 ELSE 1 END
    RETURNING request_count`,
    [tenantId, start],
  );
  if (result.rows[0].request_count > limit)
    throw new DomainError(
      "RATE_LIMITED",
      "Tenant rate limit exceeded; retry after one minute",
      429,
    );
  return Math.max(0, limit - result.rows[0].request_count);
}
