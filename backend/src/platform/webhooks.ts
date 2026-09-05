import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
import { newId } from "../ids.js";
import { canonicalize } from "../canonical.js";
import { record, textField } from "./tenants.js";

export const EVENT_TYPES = [
  "proof.created",
  "participant.joined",
  "evidence.uploaded",
  "evidence.committed",
  "capture.completed",
  "shipment.updated",
  "proof.finalized",
  "proof.accessed",
] as const;
export interface WebhookConfig {
  encryptionKey: string;
  allowedHosts: string[];
}
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  return {
    encryptionKey: env.PACKPROOF_WEBHOOK_ENCRYPTION_KEY ?? "",
    allowedHosts: (env.PACKPROOF_WEBHOOK_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
function masterKey(config: WebhookConfig): Buffer {
  const key = Buffer.from(config.encryptionKey, "base64");
  if (key.length !== 32)
    throw new DomainError("WEBHOOKS_UNAVAILABLE", "Webhook encryption is not configured", 503);
  return key;
}
export function validateWebhookUrl(value: unknown, config: WebhookConfig): URL {
  const raw = textField(value, "url", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError("INVALID_WEBHOOK_URL", "A permitted HTTPS endpoint is required", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname) ||
    !config.allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new DomainError(
      "INVALID_WEBHOOK_URL",
      "Use HTTPS on an operator-approved webhook hostname",
      400,
    );
  }
  return url;
}
function encrypt(secret: string, id: string, config: WebhookConfig): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(config), iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString("base64")).join(".");
}
function decrypt(value: string, id: string, config: WebhookConfig): string {
  const [iv, tag, bytes] = value.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", masterKey(config), iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8");
}
export function protectWebhookResponse(context: string, config: WebhookConfig) {
  return {
    seal: (value: unknown) => ({
      encrypted: encrypt(JSON.stringify(value), context, config),
    }),
    open: (value: unknown) =>
      JSON.parse(decrypt((value as { encrypted: string }).encrypted, context, config)) as unknown,
  };
}
export async function createWebhook(
  db: Database,
  clock: Clock,
  tenantId: string,
  input: unknown,
  config: WebhookConfig,
) {
  const body = record(input);
  const url = validateWebhookUrl(body.url, config).href;
  if (
    !Array.isArray(body.eventTypes) ||
    body.eventTypes.length < 1 ||
    body.eventTypes.some((t) => !EVENT_TYPES.includes(t as (typeof EVENT_TYPES)[number]))
  ) {
    throw new DomainError("INVALID_EVENT_TYPES", "Select documented event types", 400);
  }
  const count = await db.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM api_webhooks WHERE tenant_id=$1 AND revoked_at IS NULL",
    [tenantId],
  );
  if (Number(count.rows[0].count) >= 10)
    throw new DomainError("WEBHOOK_LIMIT", "Maximum 10 active endpoints per tenant", 409);
  const id = newId("wh");
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const eventTypes = [...new Set(body.eventTypes)];
  await db.query(
    `INSERT INTO api_webhooks (id,tenant_id,url,secret_ciphertext,event_types,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      id,
      tenantId,
      url,
      encrypt(secret, id, config),
      JSON.stringify(eventTypes),
      clock.now().toISOString(),
    ],
  );
  return { id, url, eventTypes, secret };
}
export async function listWebhooks(db: Database, tenantId: string) {
  return (
    await db.query(
      `SELECT id,url,event_types AS "eventTypes",created_at AS "createdAt",revoked_at AS "revokedAt" FROM api_webhooks WHERE tenant_id=$1 ORDER BY created_at,id`,
      [tenantId],
    )
  ).rows;
}
export async function revokeWebhook(db: Database, clock: Clock, tenantId: string, id: string) {
  const result = await db.query(
    `UPDATE api_webhooks SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND tenant_id=$2 RETURNING id`,
    [id, tenantId, clock.now().toISOString()],
  );
  if (!result.rows[0]) throw new DomainError("WEBHOOK_NOT_FOUND", "Webhook not found", 404);
  return { id, revoked: true };
}
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
export function verifyWebhook(
  secret: string,
  signature: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Math.abs(nowSeconds - Number(match[1])) > toleranceSeconds
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signWebhook(secret, Number(match[1]), body).split("v1=")[1], "hex"),
    Buffer.from(match[2], "hex"),
  );
}
export interface EventRow {
  id: string;
  proof_id: string;
  event_type: string;
  created_at: Date | string;
  sequence: string | number;
}
export function publicEvent(row: EventRow, tenantId: string) {
  return {
    id: row.id,
    type: row.event_type,
    apiVersion: "v1",
    tenantId,
    createdAt: new Date(row.created_at).toISOString(),
    data: { proofId: row.proof_id },
  };
}
export async function listEvents(db: Database, tenantId: string, after: unknown, proofId?: string) {
  const cursor = after == null ? "0" : String(after);
  if (!/^\d{1,18}$/.test(cursor))
    throw new DomainError("INVALID_CURSOR", "after must be an event cursor", 400);
  const found = await db.query<EventRow>(
    `SELECT o.* FROM proof_outbox o JOIN api_tenant_proofs p ON p.proof_id=o.proof_id
    WHERE p.tenant_id=$1 AND o.sequence>$2::bigint AND ($3::text IS NULL OR o.proof_id=$3) ORDER BY o.sequence LIMIT 101`,
    [tenantId, cursor, proofId ?? null],
  );
  const rows = found.rows.slice(0, 100);
  return {
    events: rows.map((r) => publicEvent(r, tenantId)),
    nextCursor: rows.length ? String(rows.at(-1)!.sequence) : cursor,
    hasMore: found.rows.length > 100,
  };
}

// Resolve and pin the address used by TLS. The allowlist alone cannot prevent
// an approved endpoint's DNS from changing to a private network address.
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast IPv6, excluding documentation and translation ranges.
  const a = address.toLowerCase();
  return (
    isIP(a) === 6 &&
    /^[23][0-9a-f]{3}:/.test(a) &&
    !/^2001:(?:0*:|0?db8:|[12][0-9a-f]:)/.test(a) &&
    !a.startsWith("2002:")
  );
}
export type WebhookTransport = (
  url: URL,
  body: string,
  headers: Record<string, string>,
) => Promise<number>;
export async function rotateWebhookSecret(
  db: Database,
  tenantId: string,
  webhookId: string,
  config: WebhookConfig,
) {
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const result = await db.query(
    "UPDATE api_webhooks SET secret_ciphertext=$3 WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id",
    [webhookId, tenantId, encrypt(secret, webhookId, config)],
  );
  if (!result.rows[0]) throw new DomainError("WEBHOOK_NOT_FOUND", "Active webhook not found", 404);
  return { id: webhookId, secret };
}
export async function retryWebhookDelivery(
  db: Database,
  clock: Clock,
  tenantId: string,
  deliveryId: string,
) {
  const result = await db.query(
    `UPDATE api_webhook_deliveries d SET state='pending',attempts=0,next_attempt_at=$3,lease_token=NULL
    FROM api_webhooks w WHERE d.id=$1 AND w.id=d.webhook_id AND w.tenant_id=$2 AND w.revoked_at IS NULL AND d.state='dead' RETURNING d.id`,
    [deliveryId, tenantId, clock.now().toISOString()],
  );
  if (!result.rows[0])
    throw new DomainError(
      "DELIVERY_NOT_RETRYABLE",
      "Only failed deliveries for an active webhook can be replayed",
      409,
    );
  return { id: deliveryId, state: "pending" };
}
export const sendWebhook: WebhookTransport = async (url, body, headers) => {
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimeout = setTimeout(() => reject(new Error("Webhook DNS timeout")), 5000);
    }),
  ]).finally(() => clearTimeout(dnsTimeout));
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Webhook DNS is not public");
  const address = addresses[0];
  return new Promise<number>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "POST",
        family: address.family,
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        signal: AbortSignal.timeout(10000),
      },
      (res) => {
        // Never follow redirects, store response bodies, or buffer an unbounded response.
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve(status);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
};

export async function dispatchWebhooks(
  db: Database,
  clock: Clock,
  config: WebhookConfig,
  transport: WebhookTransport = sendWebhook,
  batchSize = 25,
) {
  const now = clock.now().toISOString();
  // Backfill only missing deliveries; no global high-water mark can lose an
  // event whose generating transaction committed out of sequence.
  await db.query(
    `INSERT INTO api_webhook_deliveries(id,webhook_id,event_id,state,next_attempt_at)
    SELECT w.id || ':' || o.id,w.id,o.id,'pending',$1 FROM proof_outbox o
    JOIN api_tenant_proofs p ON p.proof_id=o.proof_id JOIN api_webhooks w ON w.tenant_id=p.tenant_id
    WHERE w.revoked_at IS NULL AND o.created_at>=w.created_at AND w.event_types ? o.event_type
    AND NOT EXISTS(SELECT 1 FROM api_webhook_deliveries d WHERE d.webhook_id=w.id AND d.event_id=o.id)
    ORDER BY o.sequence LIMIT 500 ON CONFLICT DO NOTHING`,
    [now],
  );
  let delivered = 0,
    failed = 0;
  for (let n = 0; n < Math.min(100, batchSize); n++) {
    const lease = newId("lease");
    const row = await db.transaction(async (tx) => {
      const found = await tx.query<{ id: string }>(
        `SELECT d.id FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id
        WHERE d.state IN ('pending','sending') AND d.next_attempt_at<=$1 AND w.revoked_at IS NULL
        ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [clock.now().toISOString()],
      );
      if (!found.rows[0]) return null;
      await tx.query(
        `UPDATE api_webhook_deliveries SET state='sending',attempts=attempts+1,lease_token=$2,next_attempt_at=$3 WHERE id=$1`,
        [found.rows[0].id, lease, new Date(clock.now().getTime() + 60000).toISOString()],
      );
      const data = await tx.query<
        EventRow & {
          delivery_id: string;
          webhook_id: string;
          tenant_id: string;
          url: string;
          secret_ciphertext: string;
          attempts: number;
        }
      >(
        `SELECT o.*,d.id AS delivery_id,d.attempts,w.id AS webhook_id,w.tenant_id,w.url,w.secret_ciphertext FROM api_webhook_deliveries d
         JOIN api_webhooks w ON w.id=d.webhook_id JOIN proof_outbox o ON o.id=d.event_id WHERE d.id=$1`,
        [found.rows[0].id],
      );
      return data.rows[0];
    });
    if (!row) break;
    let status = 0;
    try {
      const url = validateWebhookUrl(row.url, config);
      const body = canonicalize(publicEvent(row, row.tenant_id));
      const timestamp = Math.floor(clock.now().getTime() / 1000);
      status = await transport(url, body, {
        "Content-Type": "application/json",
        "PackProof-Event-Id": row.id,
        "PackProof-Signature": signWebhook(
          decrypt(row.secret_ciphertext, row.webhook_id, config),
          timestamp,
          body,
        ),
        "User-Agent": "PackProof-Webhooks/1",
      });
    } catch {
      /* Persist only a status code; endpoints and secrets never enter logs. */
    }
    const ok = status >= 200 && status < 300;
    const state = ok ? "delivered" : row.attempts >= 10 ? "dead" : "pending";
    await db.query(
      `UPDATE api_webhook_deliveries SET state=$3,last_status=$4,delivered_at=$5,next_attempt_at=$6,lease_token=NULL WHERE id=$1 AND lease_token=$2`,
      [
        row.delivery_id,
        lease,
        state,
        status || null,
        ok ? clock.now().toISOString() : null,
        new Date(
          clock.now().getTime() +
            Math.min(86400000, 30000 * 2 ** row.attempts) +
            Math.floor(Math.random() * 1000),
        ).toISOString(),
      ],
    );
    if (ok) delivered++;
    else failed++;
  }
  return { delivered, failed };
}
