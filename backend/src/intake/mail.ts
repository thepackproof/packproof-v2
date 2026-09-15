import { randomBytes, createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { newId } from "../ids.js";
import type { IntakeObservationInput, IntakeResult, IntakeScope } from "./context.js";
import { forwardingChallenge, MAIL_LIMITS, MailParseError, parseMail, type ParsedMail } from "./mail-parser.js";

type AliasState = "AWAITING_VERIFICATION" | "AWAITING_VALID_SAMPLE" | "READY" | "REVOKED";
interface AliasRow {
  id: string; owner_user_id: string; connection_id: string; address: string; state: AliasState;
  challenge_id: string | null; challenge_code: string | null; challenge_url: string | null; challenge_expires_at: string | Date | null;
  last_received_at: string | Date | null; last_error_code: string | null;
  provider: string; external_account_reference: string; connection_status: string; connection_owner: string; connection_provider: string; connection_account: string;
}
export interface MailSetupView {
  id: string; address: string; connectionId: string; provider: string; store: string; state: AliasState;
  lastReceivedAt: string | null; lastErrorCode: string | null;
  challenge: { id: string; code: string | null; url: string | null; expiresAt: string } | null;
  supportedTemplates: string[];
}
export interface MailTemplate {
  /** Register only after checking a retained, authorized real seller notification fixture. */
  key: string; version: string; provider: "ebay" | "etsy" | "shopify"; validatedFixtureSha256: string;
  matches(mail: ParsedMail): boolean;
  parse(mail: ParsedMail): Omit<IntakeObservationInput, "receiptId" | "sourceKind" | "adapterKey" | "adapterVersion" | "rawSourceRef">;
}
/** No representative merchant message was supplied. Unknown families fail closed. */
export const VALIDATED_MAIL_TEMPLATES: readonly MailTemplate[] = Object.freeze([]);
const aliasSelect = `SELECT a.*,c.provider AS connection_provider,c.external_account_reference AS connection_account,c.status AS connection_status,c.owner_user_id AS connection_owner FROM intake_mail_aliases a JOIN integration_connections c ON c.id=a.connection_id`;
const iso = (value: string | Date | null): string | null => value ? new Date(value).toISOString() : null;
function view(row: AliasRow, clock: Clock): MailSetupView {
  const expires = iso(row.challenge_expires_at);
  return { id: row.id, address: row.address, connectionId: row.connection_id, provider: row.provider, store: row.external_account_reference, state: row.state,
    lastReceivedAt: iso(row.last_received_at), lastErrorCode: row.last_error_code,
    challenge: row.state === "AWAITING_VERIFICATION" && row.challenge_id && expires && Date.parse(expires) > clock.now().getTime()
      ? { id: row.challenge_id, code: row.challenge_code, url: row.challenge_url, expiresAt: expires } : null,
    supportedTemplates: VALIDATED_MAIL_TEMPLATES.filter(t => t.provider === row.provider).map(t => `${t.key}@${t.version}`) };
}
async function ownerAlias(db: Database, owner: string, id: string, lock = false): Promise<AliasRow> {
  const row = (await db.query<AliasRow>(`${aliasSelect} WHERE a.id=$1 AND a.owner_user_id=$2${lock ? " FOR UPDATE OF a" : ""}`, [id, owner])).rows[0];
  if (!row) throw new DomainError("MAIL_ALIAS_NOT_FOUND", "Order inbox connection not found", 404);
  return row;
}
export async function listMailSetup(db: Database, clock: Clock, ownerUserId: string): Promise<MailSetupView[]> {
  return (await db.query<AliasRow>(`${aliasSelect} WHERE a.owner_user_id=$1 ORDER BY a.created_at DESC`, [ownerUserId])).rows.map(row => view(row, clock));
}
export async function createMailAlias(db: Database, clock: Clock, input: { ownerUserId: string; connectionId: string; domain: string }): Promise<MailSetupView> {
  const domain = input.domain.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/.test(domain)) throw new DomainError("MAIL_NOT_CONFIGURED", "Order inbox setup is not available yet", 503);
  return db.transaction(async tx => {
    const connection = (await tx.query<{ provider: string; external_account_reference: string | null }>(`SELECT provider,external_account_reference FROM integration_connections WHERE id=$1 AND owner_user_id=$2 AND status='ACTIVE' FOR UPDATE`, [input.connectionId, input.ownerUserId])).rows[0];
    if (!connection || !connection.external_account_reference || !["ebay", "etsy", "shopify"].includes(connection.provider)) throw new DomainError("MAIL_STORE_UNVERIFIED", "Connect and verify this store before setting up its order inbox", 409);
    const current = (await tx.query<AliasRow>(`${aliasSelect} WHERE a.owner_user_id=$1 AND a.connection_id=$2 AND a.state<>'REVOKED'`, [input.ownerUserId, input.connectionId])).rows[0];
    if (current) {
      if (current.provider !== connection.provider || current.external_account_reference !== connection.external_account_reference)
        throw new DomainError("MAIL_STORE_SCOPE_CHANGED", "This store connection changed. Revoke the old forwarding address and create a new one", 409);
      return view(current, clock);
    }
    const id = newId("mal"), now = clock.now().toISOString(), address = `${randomBytes(24).toString("hex")}@${domain}`;
    await tx.query(`INSERT INTO intake_mail_aliases(id,owner_user_id,connection_id,address,state,created_at,updated_at,provider,external_account_reference) VALUES($1,$2,$3,$4,'AWAITING_VERIFICATION',$5,$5,$6,$7)`, [id, input.ownerUserId, input.connectionId, address, now, connection.provider, connection.external_account_reference]);
    return view(await ownerAlias(tx, input.ownerUserId, id), clock);
  });
}
export async function revokeMailAlias(db: Database, clock: Clock, owner: string, id: string): Promise<MailSetupView> {
  return db.transaction(async tx => {
    await ownerAlias(tx, owner, id, true);
    await tx.query(`UPDATE intake_mail_aliases SET state='REVOKED',revoked_at=$2,updated_at=$2,challenge_id=NULL,challenge_code=NULL,challenge_url=NULL,challenge_expires_at=NULL WHERE id=$1`, [id, clock.now().toISOString()]);
    return view(await ownerAlias(tx, owner, id), clock);
  });
}
/** Owner attests they completed Gmail's own verification; a mail From header never does. */
export async function acknowledgeMailVerification(db: Database, clock: Clock, owner: string, id: string, challengeId: string): Promise<MailSetupView> {
  return db.transaction(async tx => {
    const alias = await ownerAlias(tx, owner, id, true);
    if (alias.state === "AWAITING_VALID_SAMPLE" || alias.state === "READY") return view(alias, clock);
    if (alias.state !== "AWAITING_VERIFICATION" || !challengeId || challengeId !== alias.challenge_id || !alias.challenge_expires_at || new Date(alias.challenge_expires_at).getTime() <= clock.now().getTime()) throw new DomainError("MAIL_CHALLENGE_EXPIRED", "Request a new forwarding verification message, then finish verification with your email provider", 409);
    await tx.query(`UPDATE intake_mail_aliases SET state='AWAITING_VALID_SAMPLE',verified_at=$2,updated_at=$2,challenge_id=NULL,challenge_code=NULL,challenge_url=NULL,challenge_expires_at=NULL,last_error_code=NULL WHERE id=$1`, [id, clock.now().toISOString()]);
    return view(await ownerAlias(tx, owner, id), clock);
  });
}
export interface TrustedSesConfig { topicArn: string; bucket: string; keyPrefix: string }
/** Call exclusively on messages received from the IAM-restricted SQS queue, never HTTP/page input.
 * SNS signatures are not authenticated here: the queue policy is the trust boundary.
 */
export async function acceptTrustedSesReceipt(db: Database, clock: Clock, queueBody: string, config: TrustedSesConfig): Promise<{ accepted: number; ignored: number }> {
  if (Buffer.byteLength(queueBody) > 65536) throw new DomainError("MAIL_INGRESS_INVALID", "Invalid mail ingress envelope", 400);
  let wrapper: any, event: any;
  try { wrapper = JSON.parse(queueBody); if (typeof wrapper.Message !== "string") throw new Error(); event = JSON.parse(wrapper.Message); if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(); } catch { throw new DomainError("MAIL_INGRESS_INVALID", "Invalid mail ingress envelope", 400); }
  const action = event?.receipt?.action;
  if (!config.topicArn || !config.bucket || !config.keyPrefix || wrapper.Type !== "Notification" || wrapper.TopicArn !== config.topicArn || event.notificationType !== "Received" || action?.type !== "S3" || action.bucketName !== config.bucket || typeof action.objectKey !== "string" || !action.objectKey.startsWith(config.keyPrefix) || action.objectKey.length > 1024 || /[\u0000-\u001f]/.test(action.objectKey) || typeof event.mail?.messageId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(event.mail.messageId) || !Array.isArray(event.receipt.recipients) || event.receipt.recipients.length > 20) throw new DomainError("MAIL_INGRESS_INVALID", "Invalid mail ingress envelope", 400);
  // To/Delivered-To headers are deliberately ignored.
  const recipients = [...new Set<string>(event.receipt.recipients.filter((v: unknown) => typeof v === "string").map((v: string) => v.toLowerCase()))];
  const verdict = event.receipt.spamVerdict?.status === "PASS" && event.receipt.virusVerdict?.status === "PASS" ? "PASS" : "SUSPICIOUS";
  let accepted = 0, ignored = 0;
  for (const address of recipients) {
    const result = await db.transaction(async tx => {
      const alias = (await tx.query<{ id: string }>(`SELECT id FROM intake_mail_aliases WHERE address=$1 AND state<>'REVOKED' FOR UPDATE`, [address])).rows[0];
      if (!alias) return false;
      const existing = (await tx.query(`SELECT id FROM intake_mail_receipts WHERE alias_id=$1 AND receipt_id=$2`, [alias.id, event.mail.messageId])).rows[0];
      if (existing) return true;
      const now = clock.now(), id = newId("mrc");
      const count = (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM intake_mail_receipts WHERE alias_id=$1 AND received_at>$2`, [alias.id, new Date(now.getTime() - 3600000).toISOString()])).rows[0];
      const limited = Number(count?.count ?? 0) >= 60;
      await tx.query(`INSERT INTO intake_mail_receipts(id,alias_id,receipt_id,bucket,object_key,received_at,transport_verdict,outcome,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, alias.id, event.mail.messageId, config.bucket, action.objectKey, now.toISOString(), verdict, limited ? "QUARANTINED" : null, limited ? "ALIAS_RATE_LIMIT" : null]);
      await tx.query(`INSERT INTO intake_mail_jobs(receipt_id,state,next_attempt_at,last_error_code) VALUES($1,$2,$3,$4)`, [id, limited ? "QUARANTINED" : "PENDING", now.toISOString(), limited ? "ALIAS_RATE_LIMIT" : null]);
      await tx.query(`UPDATE intake_mail_aliases SET last_received_at=$2,updated_at=$2,last_error_code=$3 WHERE id=$1`, [alias.id, now.toISOString(), limited ? "ALIAS_RATE_LIMIT" : null]);
      return true;
    });
    if (result) accepted++; else ignored++;
  }
  return { accepted, ignored }; // Queue may acknowledge only after this durable commit.
}
interface MailJob { id: string; alias_id: string; bucket: string; object_key: string; transport_verdict: string; attempts: number; lease_token: string; raw_sha256: string | null }
export interface MailWorkerDependencies {
  /** Must enforce maxBytes while streaming, before buffering the complete object. */
  readRawObject(bucket: string, key: string, maxBytes: number): Promise<Buffer>;
  /** Same transaction; shared intake receiptId must be idempotent after worker crashes. */
  submitObservation(db: Database, clock: Clock, actor: string, input: IntakeObservationInput, scope: IntakeScope): Promise<IntakeResult>;
  templates?: readonly MailTemplate[];
  /** Runtime cohort filter: paused owners retain pending jobs without spending retry attempts. */
  allowedOwnerIds?: readonly string[];
}
async function claimJob(db: Database, clock: Clock, allowedOwnerIds?: readonly string[]): Promise<MailJob | null> {
  return db.transaction(async tx => {
    const now = clock.now().toISOString();
    const job = (await tx.query<{ receipt_id: string }>(`SELECT j.receipt_id FROM intake_mail_jobs j JOIN intake_mail_receipts r ON r.id=j.receipt_id JOIN intake_mail_aliases a ON a.id=r.alias_id WHERE j.state IN ('PENDING','RETRY','RUNNING') AND j.next_attempt_at<=$1 AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=$1) AND ($2::text[] IS NULL OR a.owner_user_id=ANY($2::text[])) ORDER BY j.next_attempt_at,j.receipt_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [now,allowedOwnerIds===undefined?null:[...allowedOwnerIds]])).rows[0];
    if (!job) return null;
    const token = newId("mlease");
    await tx.query(`UPDATE intake_mail_jobs SET state='RUNNING',attempts=attempts+1,lease_token=$2,lease_expires_at=$3 WHERE receipt_id=$1`, [job.receipt_id, token, new Date(clock.now().getTime() + 60000).toISOString()]);
    return (await tx.query<MailJob>(`SELECT r.*,j.attempts,j.lease_token FROM intake_mail_receipts r JOIN intake_mail_jobs j ON j.receipt_id=r.id WHERE r.id=$1`, [job.receipt_id])).rows[0];
  });
}
async function completeJob(tx: Database, clock: Clock, job: MailJob, outcome: string, errorCode: string | null, digest?: string, parserVersion?: string): Promise<void> {
  const now = clock.now().toISOString();
  await tx.query(`UPDATE intake_mail_receipts SET raw_sha256=COALESCE(raw_sha256,$2),parser_version=COALESCE($3,parser_version),outcome=$4,error_code=$5,processed_at=$6 WHERE id=$1`, [job.id, digest ?? null, parserVersion ?? null, outcome, errorCode, now]);
  await tx.query(`UPDATE intake_mail_jobs SET state=$2,lease_token=NULL,lease_expires_at=NULL,last_error_code=$3 WHERE receipt_id=$1 AND lease_token=$4`, [job.id, outcome === "QUARANTINED" ? "QUARANTINED" : "DONE", errorCode, job.lease_token]);
  await tx.query(`UPDATE intake_mail_aliases SET last_error_code=$2,updated_at=$3 WHERE id=$1`, [job.alias_id, errorCode, now]);
}
async function processJob(db: Database, clock: Clock, job: MailJob, deps: MailWorkerDependencies): Promise<void> {
  if (job.attempts > 5) throw new MailParseError("RETRY_EXHAUSTED");
  const raw = await deps.readRawObject(job.bucket, job.object_key, MAIL_LIMITS.bytes);
  if (raw.length > MAIL_LIMITS.bytes) throw new MailParseError("MESSAGE_TOO_LARGE");
  const digest = createHash("sha256").update(raw).digest("hex");
  if (job.raw_sha256 && job.raw_sha256 !== digest) throw new MailParseError("SOURCE_OBJECT_CHANGED");
  const retained = await db.transaction(async tx => {
    const lease = (await tx.query(`SELECT receipt_id FROM intake_mail_jobs WHERE receipt_id=$1 AND lease_token=$2 AND lease_expires_at>$3 FOR UPDATE`, [job.id, job.lease_token, clock.now().toISOString()])).rows[0];
    if (!lease) return false;
    await tx.query(`UPDATE intake_mail_receipts SET raw_sha256=COALESCE(raw_sha256,$2) WHERE id=$1`, [job.id, digest]);
    return true;
  });
  if (!retained) return;
  const parsed = job.transport_verdict === "PASS" ? parseMail(raw) : null;
  await db.transaction(async tx => {
    const lease = (await tx.query<{ lease_token: string }>(`SELECT lease_token FROM intake_mail_jobs WHERE receipt_id=$1 AND state='RUNNING' AND lease_token=$2 AND lease_expires_at>$3 FOR UPDATE`, [job.id, job.lease_token, clock.now().toISOString()])).rows[0];
    if (!lease) return; // A newer worker owns this receipt; this worker is fenced out.
    const alias = (await tx.query<AliasRow>(`${aliasSelect} WHERE a.id=$1 FOR UPDATE OF a`, [job.alias_id])).rows[0];
    if (!alias || alias.state === "REVOKED" || alias.connection_status !== "ACTIVE" || alias.connection_owner !== alias.owner_user_id) return completeJob(tx, clock, job, "QUARANTINED", "ALIAS_OR_STORE_INACTIVE", digest);
    if (alias.provider !== alias.connection_provider || alias.external_account_reference !== alias.connection_account) return completeJob(tx, clock, job, "QUARANTINED", "MAIL_STORE_SCOPE_CHANGED", digest);
    if (!parsed) return completeJob(tx, clock, job, "QUARANTINED", "SUSPICIOUS_TRANSPORT", digest);
    const duplicate = (await tx.query(`SELECT id FROM intake_mail_receipts WHERE alias_id=$1 AND raw_sha256=$2 AND id<>$3 AND outcome IN ('READY','NEEDS_INFORMATION','VERIFICATION') LIMIT 1`, [alias.id, digest, job.id])).rows[0];
    if (duplicate) return completeJob(tx, clock, job, "DUPLICATE", null, digest);
    const challenge = forwardingChallenge(parsed);
    if (challenge && alias.state === "AWAITING_VERIFICATION") {
      await tx.query(`UPDATE intake_mail_aliases SET challenge_id=$2,challenge_code=$3,challenge_url=$4,challenge_expires_at=$5 WHERE id=$1`, [alias.id, newId("mchallenge"), challenge.code, challenge.url, new Date(clock.now().getTime() + 20 * 60000).toISOString()]);
      return completeJob(tx, clock, job, "VERIFICATION", null, digest, "gmail-forwarding-candidate-v1");
    }
    if (alias.state === "AWAITING_VERIFICATION") return completeJob(tx, clock, job, "NEEDS_INFORMATION", "FORWARDING_NOT_VERIFIED", digest);
    const matches = (deps.templates ?? VALIDATED_MAIL_TEMPLATES).filter(t => t.provider === alias.provider && /^[a-f0-9]{64}$/.test(t.validatedFixtureSha256) && t.matches(parsed));
    if (matches.length !== 1) return completeJob(tx, clock, job, "QUARANTINED", matches.length > 1 ? "AMBIGUOUS_TEMPLATE" : "UNSUPPORTED_TEMPLATE", digest);
    const template = matches[0];
    const input: IntakeObservationInput = { ...template.parse(parsed), receiptId: `mail:${alias.id}:${digest}`, sourceKind: "FORWARDED_EMAIL", adapterKey: template.key, adapterVersion: template.version, rawSourceRef: `s3://${job.bucket}/${job.object_key}` };
    const scope: IntakeScope = { provider: alias.provider, externalAccountReference: alias.external_account_reference, namespaceSource: alias.provider === "shopify" ? "STOREFRONT_API" : "MARKETPLACE_API", connectionId: alias.connection_id, store: alias.external_account_reference, verified: true };
    const result = await deps.submitObservation(tx, clock, alias.owner_user_id, input, scope);
    if (result.readiness === "READY") await tx.query(`UPDATE intake_mail_aliases SET state='READY',sample_validated_at=COALESCE(sample_validated_at,$2) WHERE id=$1`, [alias.id, clock.now().toISOString()]);
    await completeJob(tx, clock, job, result.readiness, result.reasons[0] ?? null, digest, `${template.key}@${template.version}`);
  });
}
export async function dispatchMailJobs(db: Database, clock: Clock, deps: MailWorkerDependencies, limit = 5): Promise<{ completed: number; failed: number }> {
  let completed = 0, failed = 0;
  for (let i = 0; i < Math.min(10, Math.max(1, limit)); i++) {
    const job = await claimJob(db, clock, deps.allowedOwnerIds);
    if (!job) break;
    try { await processJob(db, clock, job, deps); completed++; }
    catch (error) {
      failed++;
      const code = error instanceof MailParseError ? error.code : "MAIL_PROCESSING_RETRY";
      await db.transaction(async tx => {
        const live = (await tx.query(`SELECT receipt_id FROM intake_mail_jobs WHERE receipt_id=$1 AND lease_token=$2 FOR UPDATE`, [job.id, job.lease_token])).rows[0];
        if (!live) return;
        if (error instanceof MailParseError || job.attempts >= 5) return completeJob(tx, clock, job, "QUARANTINED", job.attempts >= 5 ? "RETRY_EXHAUSTED" : code);
        await tx.query(`UPDATE intake_mail_jobs SET state='RETRY',next_attempt_at=$2,lease_token=NULL,lease_expires_at=NULL,last_error_code=$3 WHERE receipt_id=$1`, [job.id, new Date(clock.now().getTime() + Math.min(3600000, 1000 * 2 ** job.attempts)).toISOString(), code]);
        await tx.query(`UPDATE intake_mail_aliases SET last_error_code=$2,updated_at=$3 WHERE id=$1`, [job.alias_id, code, clock.now().toISOString()]);
      });
    }
  }
  return { completed, failed };
}
export async function replayMailReceipt(db: Database, clock: Clock, owner: string, aliasId: string, receiptId: string): Promise<{ queued: true }> {
  return db.transaction(async tx => {
    const alias = await ownerAlias(tx, owner, aliasId, true);
    if (alias.state === "REVOKED") throw new DomainError("MAIL_ALIAS_REVOKED", "Create a new inbox connection to resume forwarding", 409);
    const row = (await tx.query(`UPDATE intake_mail_jobs j SET state='PENDING',attempts=0,replay_count=replay_count+1,next_attempt_at=$3,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL FROM intake_mail_receipts r WHERE j.receipt_id=r.id AND r.id=$1 AND r.alias_id=$2 AND j.state='QUARANTINED' AND j.replay_count<3 RETURNING j.receipt_id`, [receiptId, aliasId, clock.now().toISOString()])).rows[0];
    if (!row) throw new DomainError("MAIL_REPLAY_UNAVAILABLE", "This message cannot be retried; check the inbox connection status", 409);
    return { queued: true };
  });
}
