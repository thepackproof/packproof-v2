import { createHash } from "node:crypto";
import type { Clock } from "../../clock.js";
import type { Database } from "../../db/database.js";
import { DomainError } from "../../domain/errors.js";
import { IntegrationError } from "../../domain/integration-errors.js";

/** Etsy quotas belong to the application key, across every shop and process. */
export function createEtsyRequestBudget(db: Database, clock: Clock, clientId: string, options: {
  dailyLimit?: number;
  spacingMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
} = {}) {
  const clientHash = createHash("sha256").update(`etsy:${clientId}`).digest("hex");
  const dailyLimit = options.dailyLimit ?? 4500; // Leave headroom under the registered 5,000/day quota.
  const spacingMs = options.spacingMs ?? 300; // Below five requests in every rolling second.
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 4500 ||
      !Number.isSafeInteger(spacingMs) || spacingMs < 250 || spacingMs > 60_000) {
    throw new Error("Invalid Etsy request budget");
  }

  async function beforeRequest(): Promise<void> {
    const now = clock.now().getTime();
    const nowIso = new Date(now).toISOString();
    const minute = Math.floor(now / 60_000) * 60_000;
    const result = await db.transaction(async tx => {
      await tx.query(`INSERT INTO etsy_request_budget(client_hash,next_request_at,updated_at)
        VALUES($1,$2,$2) ON CONFLICT(client_hash) DO NOTHING`, [clientHash, nowIso]);
      const row = (await tx.query<{next_request_at: Date|string; blocked_until: Date|string|null}>(
        "SELECT next_request_at,blocked_until FROM etsy_request_budget WHERE client_hash=$1 FOR UPDATE", [clientHash])).rows[0];
      const blocked = row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
      if (blocked > now) return {retryMs: blocked - now, delay: 0};
      // Keep the whole boundary minute: deliberately conservative rolling 24-hour count.
      const cutoff = new Date(minute - 86_400_000).toISOString();
      await tx.query("DELETE FROM etsy_request_usage WHERE client_hash=$1 AND minute_start<$2", [clientHash, cutoff]);
      const usage = (await tx.query<{total:string; oldest:Date|string|null}>(
        "SELECT COALESCE(SUM(request_count),0)::text AS total, MIN(minute_start) AS oldest FROM etsy_request_usage WHERE client_hash=$1", [clientHash])).rows[0];
      if (Number(usage.total) >= dailyLimit) {
        const oldest = usage.oldest ? new Date(usage.oldest).getTime() : now;
        return {retryMs: Math.max(60_000, oldest + 86_460_000 - now), delay: 0};
      }
      const reservedAt = Math.max(now, new Date(row.next_request_at).getTime());
      if (reservedAt - now > 1500) return {retryMs: reservedAt - now, delay: 0};
      await tx.query("UPDATE etsy_request_budget SET next_request_at=$2,updated_at=$3 WHERE client_hash=$1", [clientHash, new Date(reservedAt + spacingMs).toISOString(), nowIso]);
      await tx.query(`INSERT INTO etsy_request_usage(client_hash,minute_start,request_count) VALUES($1,$2,1)
        ON CONFLICT(client_hash,minute_start) DO UPDATE SET request_count=etsy_request_usage.request_count+1`, [clientHash, new Date(minute).toISOString()]);
      return {retryMs: 0, delay: reservedAt - now};
    });
    if (result.retryMs > 0) throw rateLimited(result.retryMs);
    if (result.delay > 0) await wait(result.delay);
    // Another worker may receive a provider cooldown while this request waits.
    const latest = (await db.query<{blocked_until:Date|string|null}>(
      "SELECT blocked_until FROM etsy_request_budget WHERE client_hash=$1", [clientHash])).rows[0];
    const blocked = latest?.blocked_until ? new Date(latest.blocked_until).getTime() : 0;
    if (blocked > clock.now().getTime()) throw rateLimited(blocked - clock.now().getTime());
  }

  async function afterResponse(response: Pick<Response, "status" | "headers">): Promise<void> {
    const remaining = response.headers.get("x-remaining-today");
    if (response.status !== 429 && !(remaining !== null && /^\d+$/.test(remaining) && Number(remaining) <= 25)) return;
    const raw = response.headers.get("retry-after");
    const now = clock.now().getTime();
    const parsed = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : NaN;
    const delay = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 86_400_000) : remaining !== null && Number(remaining) <= 25 ? 3_600_000 : 60_000;
    const until = new Date(now + Math.max(1000, delay)).toISOString();
    await db.query(`INSERT INTO etsy_request_budget(client_hash,next_request_at,blocked_until,updated_at)
      VALUES($1,$2,$3,$2) ON CONFLICT(client_hash) DO UPDATE SET
      blocked_until=GREATEST(etsy_request_budget.blocked_until,EXCLUDED.blocked_until),updated_at=EXCLUDED.updated_at`,
      [clientHash, new Date(now).toISOString(), until]);
  }
  return {beforeRequest, afterResponse};
}

function rateLimited(milliseconds: number): DomainError & {retryAfterSeconds:number} {
  return Object.assign(new IntegrationError("PROVIDER_RATE_LIMITED", "Etsy's request allowance is temporarily unavailable. Automatic intake will retry.", 429, true),
    {retryAfterSeconds: Math.max(1, Math.ceil(milliseconds / 1000))});
}
