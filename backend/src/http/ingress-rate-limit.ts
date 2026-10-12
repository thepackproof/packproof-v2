import { createHash } from 'node:crypto';
import { ipKeyGenerator, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { safeHttpError } from './boundary.js';

export interface IngressRatePolicy {
  scope: string;
  limit: number;
  windowMs: number;
}

// These IP budgets bound work before authentication. The existing authenticated
// tenant and public-link budgets remain independent and unchanged.
export const ingressRatePolicies = {
  ebayDeletion: { scope: 'ebay-deletion-verification', limit: 120, windowMs: 60_000 },
  subscriptions: { scope: 'participant-subscriptions', limit: 120, windowMs: 60_000 },
  devLogin: { scope: 'dev-login', limit: 60, windowMs: 60_000 },
  // Multipart recordings can make dozens of authenticated calls. This ingress
  // ceiling bounds authentication work without replacing tighter account budgets.
  firstPartyAuth: { scope: 'first-party-auth', limit: 600, windowMs: 60_000 },
  openApi: { scope: 'public-openapi', limit: 120, windowMs: 60_000 },
} satisfies Record<string, IngressRatePolicy>;

/** Atomic shared counters; existing operational cleanup removes expired rows. */
export class PostgresIngressRateStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;

  constructor(
    private readonly db: Database,
    private readonly policy: IngressRatePolicy,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!/^[a-z0-9_-]{1,64}$/.test(policy.scope)
      || !Number.isSafeInteger(policy.limit) || policy.limit < 1 || policy.limit >= 2_147_483_647
      || !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1_000) {
      throw new Error('Invalid ingress rate limit configuration');
    }
    this.prefix = policy.scope;
  }

  private hash(key: string): string {
    // Do not persist raw IPs, credentials, Proof ids, or request bodies.
    return createHash('sha256').update(`${this.policy.scope}:${key}`).digest('hex');
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const window = Math.floor(this.now() / this.policy.windowMs);
    const result = await this.db.query<{ request_count: number }>(
      `INSERT INTO http_rate_windows(bucket_hash,window_start,request_count,expires_at)
       VALUES($1,$2,1,$3) ON CONFLICT(bucket_hash,window_start)
       DO UPDATE SET request_count=LEAST(http_rate_windows.request_count+1,$4)
       RETURNING request_count`,
      [this.hash(key), window, new Date((window + 2) * this.policy.windowMs).toISOString(), this.policy.limit + 1],
    );
    const totalHits = result.rows[0]?.request_count;
    if (!Number.isInteger(totalHits) || totalHits < 1) throw new Error('Rate counter unavailable');
    return { totalHits, resetTime: new Date((window + 1) * this.policy.windowMs) };
  }

  async decrement(key: string): Promise<void> {
    const params = [this.hash(key), Math.floor(this.now() / this.policy.windowMs)];
    await this.db.transaction(async tx => {
      const { rows } = await tx.query<{ request_count: number }>(
        'SELECT request_count FROM http_rate_windows WHERE bucket_hash=$1 AND window_start=$2 FOR UPDATE', params,
      );
      if (!rows.length) return;
      // The shared table deliberately never stores zero-count rows.
      await tx.query(rows[0].request_count === 1
        ? 'DELETE FROM http_rate_windows WHERE bucket_hash=$1 AND window_start=$2'
        : 'UPDATE http_rate_windows SET request_count=request_count-1 WHERE bucket_hash=$1 AND window_start=$2', params);
    });
  }

  async resetKey(key: string): Promise<void> {
    await this.db.query('DELETE FROM http_rate_windows WHERE bucket_hash=$1', [this.hash(key)]);
  }
}

/** Pass to express-rate-limit at the route boundary, before expensive work. */
export function ingressRateLimitOptions(db: Database, policy: IngressRatePolicy): Partial<Options> {
  return {
    windowMs: policy.windowMs,
    limit: policy.limit,
    store: new PostgresIngressRateStore(db, policy),
    // req.ip is resolved by configureTrustedProxy, never by trusting raw headers.
    // A /56 groups rotating IPv6 addresses into the same caller budget.
    keyGenerator: req => ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown', 56),
    legacyHeaders: false,
    standardHeaders: 'draft-7',
    skipFailedRequests: false,
    skipSuccessfulRequests: false,
    passOnStoreError: false,
    handler: (_req, res) => safeHttpError(new DomainError('RATE_LIMITED', 'Please wait before trying again', 429), res),
  };
}
