import { providerRateLimited } from "../domain/integration-errors.js";

/** Keep server-directed retry guidance out of logs and defer the durable job accordingly. */
export function rateLimitDelay(header: string | null, quotaSeconds: number | null = null) {
  const numeric = header?.trim() ? Number(header) : NaN;
  const dated = header && !Number.isFinite(numeric) ? (Date.parse(header) - Date.now()) / 1000 : NaN;
  const seconds = Math.max(Number.isFinite(numeric) ? numeric : Number.isFinite(dated) ? dated : 0, quotaSeconds ?? 0);
  return Object.assign(providerRateLimited(), {retryAfterSeconds: Math.min(86400, Math.max(0, Math.ceil(seconds)))});
}
