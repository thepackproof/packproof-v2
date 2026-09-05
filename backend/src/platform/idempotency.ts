import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "../domain/errors.js";
import { textField } from "./tenants.js";

export async function idempotent<T>(
  db: Database,
  clock: Clock,
  tenantId: string,
  operation: string,
  key: unknown,
  body: unknown,
  run: (tx: Database) => Promise<T>,
  protection?: {
    seal: (value: unknown) => unknown;
    open: (value: unknown) => unknown;
  },
): Promise<{ value: T; replayed: boolean }> {
  const keyHash = sha256Hex(textField(key, "Idempotency-Key", 200));
  const requestHash = sha256Hex(canonicalize(body ?? {}));
  return db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO api_idempotency (tenant_id,operation,key_hash,request_hash,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tenantId, operation, keyHash, requestHash, clock.now().toISOString()],
    );
    const existing = await tx.query<{
      request_hash: string;
      response: T | null;
    }>(
      `SELECT request_hash,response FROM api_idempotency WHERE tenant_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE`,
      [tenantId, operation, keyHash],
    );
    const row = existing.rows[0];
    if (row.request_hash !== requestHash)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This key was already used with a different request",
        409,
      );
    if (row.response !== null)
      return {
        value: (protection ? protection.open(row.response) : row.response) as T,
        replayed: true,
      };
    const value = await run(tx);
    await tx.query(
      `UPDATE api_idempotency SET response=$4::jsonb WHERE tenant_id=$1 AND operation=$2 AND key_hash=$3`,
      [tenantId, operation, keyHash, JSON.stringify(protection ? protection.seal(value) : value)],
    );
    return { value, replayed: false };
  });
}
