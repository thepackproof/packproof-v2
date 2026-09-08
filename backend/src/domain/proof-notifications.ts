import { createHmac, randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import type { EmailDelivery } from "../integrations/email/delivery.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import { requireParticipant, loadProof } from "./proof-access.js";
import { getDisclosureProjection, resolveDisclosureContext } from "./disclosure.js";
import { verifiedReceiptContact } from "./buyer-receipt.js";
import {
  buildProofTracker,
  type ProofTrackerView,
  type TrackerMilestoneCode,
} from "./proof-tracker.js";
import { requireAccessLinkScope, type AccessLinkScope } from "./workflow.js";

export const NOTIFICATION_PREFERENCES = ["IMPORTANT", "ALL", "FINAL_ONLY"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

interface SubscriptionRow {
  id: string;
  proof_id: string;
  email: string;
  email_normalized: string;
  preference: NotificationPreference;
  scope: AccessLinkScope;
  access_link_id: string;
  created_by_user_id: string;
  processed_milestones: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
  recipient_user_id: string | null;
  recipient_grant_id?: string | null;
}

interface OutboxRow {
  id: string;
  proof_id: string;
  subscription_id: string;
  event_key: string;
  attempt_count: number | string;
  email: string;
  preference: NotificationPreference;
  scope: AccessLinkScope;
  revoked_at: Date | string | null;
  recipient_user_id: string | null;
}

export interface ProofEmailSubscriptionView {
  subscriptionId: string;
  proofId: string;
  email: string;
  preference: NotificationPreference;
  scope: AccessLinkScope;
  createdAt: string;
  revokedAt: string | null;
  viewUrl: string;
}

export async function createProofEmailSubscription(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    email: unknown;
    preference?: unknown;
    scope?: unknown;
    publicWebBaseUrl: string;
    trackerLinkSecret: string;
    recipientGrantId?: unknown;
  },
): Promise<ProofEmailSubscriptionView> {
  const email = requireEmail(input.email);
  const normalized = email.toLowerCase();
  const preference = requirePreference(input.preference);
  const scope = requireAccessLinkScope(input.scope);
  await requireParticipant(db, proofId, actorUserId, "SELLER");
  const recipientUserId = await verifiedReceiptContact(db, proofId, normalized);
  requireTrackerSecret(input.trackerLinkSecret);

  return db.transaction(async (tx) => {
    await loadProof(tx, proofId, true);
    const participant = await requireParticipant(tx, proofId, actorUserId);
    // Baseline capture belongs under the same Proof lock as subscription creation.
    // It cannot race a committed milestone and create a false historical update.
    const tracker = await buildProofTracker(tx, proofId);
    const baseline = tracker.milestones
      .filter((milestone) => milestone.state === "COMPLETE")
      .map((milestone) => milestone.code);
    const now = clock.now();
    const existing = await tx.query<SubscriptionRow>(
      `SELECT * FROM proof_notification_subscriptions
        WHERE proof_id = $1 AND email_normalized = $2 AND revoked_at IS NULL`,
      [proofId, normalized],
    );
    if (existing.rows[0]) {
      const old = existing.rows[0];
      const usable = (await tx.query("SELECT 1 FROM proof_access_links WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)", [old.access_link_id, now.toISOString()])).rows[0];
      if (usable) {
        if (input.recipientGrantId !== undefined) {
          const version = await copyReceiptGrant(tx,clock,actorUserId,proofId,old.access_link_id,input.recipientGrantId);
          await tx.query("UPDATE proof_notification_subscriptions SET recipient_grant_id=$2,recipient_user_id=$3,updated_at=$4 WHERE id=$1", [old.id,input.recipientGrantId,recipientUserId,now.toISOString()]);
          if (version !== null || old.recipient_grant_id !== input.recipientGrantId) {
            await enqueueOutbox(tx,now,proofId,old.id,`RECEIPT_SCOPE:${input.recipientGrantId}:${version ?? 'same'}`);
            await appendAudit(tx,{proofId,actorUserId,eventType:"BUYER_RECEIPT_SCOPE_BOUND",eventData:{subscriptionId:old.id,accessLinkId:old.access_link_id,recipientGrantId:input.recipientGrantId,scopeVersion:version},at:now});
          }
        }
        return toSubscriptionView(old, input.publicWebBaseUrl, input.trackerLinkSecret);
      }
      await tx.query("UPDATE proof_notification_subscriptions SET revoked_at=$2,updated_at=$2 WHERE id=$1",[old.id,now.toISOString()]);
      await tx.query("UPDATE proof_notification_outbox SET cancelled_at=$2 WHERE subscription_id=$1 AND sent_at IS NULL AND cancelled_at IS NULL",[old.id,now.toISOString()]);
    }

    const subscriptionId = newId("pns");
    const accessLinkId = newId("pal");
    const token = trackerAccessToken(input.trackerLinkSecret, subscriptionId);
    const tokenHash = sha256Hex(token);

    await tx.query(
      `INSERT INTO proof_access_links (
         id, proof_id, token_hash, scope, created_by_participant_id, recipient_hint,
         created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accessLinkId, proofId, tokenHash, scope, participant.id, null, now.toISOString(), new Date(now.getTime()+30*86400000).toISOString()],
    );
    if (input.recipientGrantId !== undefined) await copyReceiptGrant(tx,clock,actorUserId,proofId,accessLinkId,input.recipientGrantId);
    await tx.query(
      `INSERT INTO proof_notification_subscriptions (
         id, proof_id, email, email_normalized, preference, scope, access_link_id,
         created_by_user_id, processed_milestones, created_at, updated_at, recipient_user_id, recipient_grant_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10, $11, $12)`,
      [
        subscriptionId,
        proofId,
        email,
        normalized,
        preference,
        scope,
        accessLinkId,
        actorUserId,
        JSON.stringify(baseline),
        now.toISOString(),
        recipientUserId,
        input.recipientGrantId ?? null,
      ],
    );
    await enqueueOutbox(tx, now, proofId, subscriptionId, "TRACKER_SHARED");
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_TRACKER_EMAIL_SUBSCRIBED",
      eventData: { subscriptionId, accessLinkId, preference, scope },
      at: now,
    });

    return {
      subscriptionId,
      proofId,
      email,
      preference,
      scope,
      createdAt: now.toISOString(),
      revokedAt: null,
      viewUrl: trackerViewUrl(input.publicWebBaseUrl, input.trackerLinkSecret, subscriptionId),
    };
  });
}

export async function listProofEmailSubscriptions(
  db: Database,
  actorUserId: string,
  proofId: string,
  publicWebBaseUrl: string,
  trackerLinkSecret: string,
): Promise<ProofEmailSubscriptionView[]> {
  await requireParticipant(db, proofId, actorUserId);
  requireTrackerSecret(trackerLinkSecret);
  const found = await db.query<SubscriptionRow>(
    `SELECT * FROM proof_notification_subscriptions
      WHERE proof_id = $1
      ORDER BY created_at DESC, id DESC`,
    [proofId],
  );
  return found.rows.map((row) => toSubscriptionView(row, publicWebBaseUrl, trackerLinkSecret));
}

export async function revokeProofEmailSubscription(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  subscriptionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireParticipant(tx, proofId, actorUserId);
    const found = await tx.query<SubscriptionRow>(
      `SELECT * FROM proof_notification_subscriptions
        WHERE id = $1 AND proof_id = $2 FOR UPDATE`,
      [subscriptionId, proofId],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", "Email subscription not found", 404);
    if (row.revoked_at) return;
    const now = clock.now().toISOString();
    await tx.query(
      `UPDATE proof_notification_subscriptions SET revoked_at = $2, updated_at = $2 WHERE id = $1`,
      [subscriptionId, now],
    );
    await tx.query(`UPDATE proof_access_links SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
      row.access_link_id,
      now,
    ]);
    await tx.query(
      `UPDATE proof_notification_outbox SET cancelled_at = $2
        WHERE subscription_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`,
      [subscriptionId, now],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_TRACKER_EMAIL_REVOKED",
      eventData: { subscriptionId, accessLinkId: row.access_link_id },
      at: new Date(now),
    });
  });
}

export async function reconcileProofNotifications(
  db: Database,
  clock: Clock,
  proofId: string,
): Promise<number> {
  const tracker = await buildProofTracker(db, proofId);
  const completed = tracker.milestones
    .filter((milestone) => milestone.state === "COMPLETE")
    .map((milestone) => milestone.code);
  const subscriptions = await db.query<SubscriptionRow>(
    `SELECT * FROM proof_notification_subscriptions
      WHERE proof_id = $1 AND revoked_at IS NULL`,
    [proofId],
  );
  let enqueued = 0;
  for (const subscription of subscriptions.rows) {
    const processed = new Set(parseMilestones(subscription.processed_milestones));
    const unseen = completed.filter((code) => !processed.has(code));
    if (unseen.length === 0) continue;
    const now = clock.now();
    await db.transaction(async (tx) => {
      for (const code of unseen) {
        if (shouldNotify(subscription.preference, code)) {
          const created = await enqueueOutbox(tx, now, proofId, subscription.id, `MILESTONE:${code}`);
          if (created) enqueued += 1;
        }
        processed.add(code);
      }
      await tx.query(
        `UPDATE proof_notification_subscriptions
            SET processed_milestones = $2::jsonb, updated_at = $3
          WHERE id = $1`,
        [subscription.id, JSON.stringify(Array.from(processed)), now.toISOString()],
      );
    });
  }
  return enqueued;
}

export async function reconcileAllProofNotifications(db: Database, clock: Clock): Promise<number> {
  const proofs = await db.query<{ proof_id: string }>(
    `SELECT DISTINCT proof_id FROM proof_notification_subscriptions WHERE revoked_at IS NULL`,
  );
  let total = 0;
  for (const row of proofs.rows) total += await reconcileProofNotifications(db, clock, row.proof_id);
  return total;
}

const MAX_EMAIL_ATTEMPTS = 5;
// The release transition contains both lease namespaces. Claim/check/clear both
// atomically so old delivery_token workers and new lease_token workers cannot
// concurrently own one row during rolling deployment. Remove the bridge only
// after all old instances and their maximum leases have drained.

export async function dispatchPendingProofEmails(
  db: Database,
  clock: Clock,
  emailDelivery: EmailDelivery,
  publicWebBaseUrl: string,
  trackerLinkSecret: string,
  proofId?: string,
): Promise<{ sent: number; failed: number }> {
  requireTrackerSecret(trackerLinkSecret);
  if (!emailDelivery.enabled || process.env.PACKPROOF_RECEIPT_NOTIFICATIONS === "false")
    return { sent: 0, failed: 0 };
  const now = clock.now();
  // An instance may die after its final claim. Give that row an explicit terminal
  // state once its lease expires; repeatedly crashed workers cannot retry forever.
  await db.query(
    `UPDATE proof_notification_outbox
        SET exhausted_at=$1,cancelled_at=$1,last_error='EMAIL_ATTEMPTS_EXHAUSTED',
            lease_token=NULL,lease_until=NULL,delivery_token=NULL,delivery_lease_until=NULL
      WHERE sent_at IS NULL AND cancelled_at IS NULL AND exhausted_at IS NULL
        AND attempt_count >= $2 AND (lease_until IS NULL OR lease_until <= $1)
        AND (delivery_lease_until IS NULL OR delivery_lease_until <= $1)`,
    [now.toISOString(), MAX_EMAIL_ATTEMPTS],
  );
  const params: unknown[] = [now.toISOString(), MAX_EMAIL_ATTEMPTS];
  let proofClause = "";
  if (proofId) {
    params.push(proofId);
    proofClause = ` AND o.proof_id = $${params.length}`;
  }
  const pending = await db.query<OutboxRow>(
    `SELECT o.id, o.proof_id, o.subscription_id, o.event_key, o.attempt_count,
            s.email, s.preference, s.scope, s.revoked_at, s.recipient_user_id
       FROM proof_notification_outbox o
       JOIN proof_notification_subscriptions s ON s.id=o.subscription_id
       JOIN proof_access_links l ON l.id=s.access_link_id
      WHERE o.sent_at IS NULL AND o.cancelled_at IS NULL
        AND o.next_attempt_at <= $1 AND o.exhausted_at IS NULL
        AND o.attempt_count < $2 AND (o.lease_until IS NULL OR o.lease_until <= $1)
        AND (o.delivery_lease_until IS NULL OR o.delivery_lease_until <= $1)
        AND s.revoked_at IS NULL AND l.revoked_at IS NULL
        AND (l.expires_at IS NULL OR l.expires_at > $1)${proofClause}
      ORDER BY o.created_at ASC, o.id ASC LIMIT 25`,
    params,
  );
  let sent = 0;
  let failed = 0;
  for (const row of pending.rows) {
    const leaseToken = randomUUID();
    const claimedAt = clock.now();
    const claimed = await db.query<{ attempt_count: number | string }>(
      `UPDATE proof_notification_outbox o
          SET lease_token=$2,delivery_token=$2,lease_until=$4,delivery_lease_until=$4,
              attempt_count=attempt_count+1
        WHERE o.id=$1 AND o.sent_at IS NULL AND o.cancelled_at IS NULL
          AND o.exhausted_at IS NULL AND o.next_attempt_at <= $3
          AND o.attempt_count < $5 AND (o.lease_until IS NULL OR o.lease_until <= $3)
          AND (o.delivery_lease_until IS NULL OR o.delivery_lease_until <= $3)
          AND EXISTS (
            SELECT 1 FROM proof_notification_subscriptions s
            JOIN proof_access_links l ON l.id=s.access_link_id
            WHERE s.id=o.subscription_id AND s.revoked_at IS NULL
              AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > $3)
          )
        RETURNING attempt_count`,
      [row.id, leaseToken, claimedAt.toISOString(),
       new Date(claimedAt.getTime()+120_000).toISOString(), MAX_EMAIL_ATTEMPTS],
    );
    if (!claimed.rows[0]) continue;
    const attempts = Number(claimed.rows[0].attempt_count);
    const cancelClaim = async () => {
      await db.query(
        `UPDATE proof_notification_outbox SET cancelled_at=$3,
            lease_token=NULL,lease_until=NULL,delivery_token=NULL,delivery_lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND sent_at IS NULL`,
        [row.id, leaseToken, clock.now().toISOString()],
      );
    };
    try {
      // Read current preference, identity and scope after claiming, never merely
      // the values in the earlier candidate query.
      const active = (await db.query<{
        preference: NotificationPreference;
        email: string;
        recipient_user_id: string | null;
      }>(
        `SELECT s.preference,s.email,s.recipient_user_id
           FROM proof_notification_subscriptions s
           JOIN proof_notification_outbox o ON o.subscription_id=s.id
           JOIN proof_access_links l ON l.id=s.access_link_id
          WHERE o.id=$1 AND o.lease_token=$2 AND o.cancelled_at IS NULL
            AND s.revoked_at IS NULL AND l.revoked_at IS NULL
            AND (l.expires_at IS NULL OR l.expires_at>$3)`,
        [row.id,leaseToken,clock.now().toISOString()],
      )).rows[0];
      const milestone = row.event_key.startsWith("MILESTONE:")
        ? row.event_key.slice("MILESTONE:".length) as TrackerMilestoneCode : null;
      if (!active || (milestone && !shouldNotify(active.preference,milestone))) {
        await cancelClaim();
        continue;
      }
      const verifiedUserId = await verifiedReceiptContact(db,row.proof_id,active.email);
      if (active.recipient_user_id !== verifiedUserId)
        throw new DomainError("RECEIPT_CONTACT_UNVERIFIED","Recipient changed",409);
      const token = trackerAccessToken(trackerLinkSecret,row.subscription_id);
      const context = await resolveDisclosureContext(db,clock,{token});
      // This supersedes trackerForScope: one central projection controls fields,
      // parent-grant revocation, and which milestone may appear in email text.
      const projection = await getDisclosureProjection(db,context);
      if (milestone && !projection.tracker.milestones.some(
        event => event.code === milestone && event.state === "COMPLETE",
      )) {
        await cancelClaim();
        continue;
      }
      const viewUrl = trackerViewUrl(publicWebBaseUrl,trackerLinkSecret,row.subscription_id);
      const message = emailForEvent(row.event_key,projection.tracker,viewUrl,active.email);
      const latestContext = await resolveDisclosureContext(db,clock,{token});
      if (latestContext.scopeVersion !== context.scopeVersion ||
          latestContext.scopeIdentity !== context.scopeIdentity ||
          latestContext.policyVersion !== context.policyVersion) {
        await cancelClaim();
        continue;
      }
      // Consent and preference can change while the scoped projection is built.
      const stillActive = (await db.query<{ preference: NotificationPreference }>(
        `SELECT s.preference FROM proof_notification_outbox o
           JOIN proof_notification_subscriptions s ON s.id=o.subscription_id
           JOIN proof_access_links l ON l.id=s.access_link_id
           JOIN proof_receipt_preferences p ON p.proof_id=s.proof_id
             AND p.user_id=s.recipient_user_id AND p.opted_in=TRUE
           JOIN user_verified_contacts c ON c.user_id=s.recipient_user_id
             AND c.email_normalized=s.email_normalized
          WHERE o.id=$1 AND o.lease_token=$2 AND o.cancelled_at IS NULL
            AND s.revoked_at IS NULL AND l.revoked_at IS NULL
            AND s.email=$4 AND s.recipient_user_id=$5
            AND (l.expires_at IS NULL OR l.expires_at>$3)`,
        [row.id,leaseToken,clock.now().toISOString(),active.email,verifiedUserId],
      )).rows[0];
      if (!stillActive || (milestone && !shouldNotify(stillActive.preference,milestone))) {
        await cancelClaim();
        continue;
      }
      await emailDelivery.send(message);
      await db.query(
        `UPDATE proof_notification_outbox
            SET sent_at=$3,last_error=NULL,lease_token=NULL,lease_until=NULL,
                delivery_token=NULL,delivery_lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND sent_at IS NULL`,
        [row.id,leaseToken,clock.now().toISOString()],
      );
      sent += 1;
    } catch (error) {
      const delayMs = Math.min(60*60*1000,30_000*2**Math.min(attempts-1,7));
      await db.query(
        `UPDATE proof_notification_outbox
            SET last_error=$3,next_attempt_at=$4,lease_token=NULL,lease_until=NULL,
                delivery_token=NULL,delivery_lease_until=NULL,
                cancelled_at=CASE WHEN attempt_count >= $5 THEN $6::timestamptz ELSE cancelled_at END,
                exhausted_at=CASE WHEN attempt_count >= $5 THEN $6::timestamptz ELSE NULL END
          WHERE id=$1 AND lease_token=$2 AND sent_at IS NULL`,
        [row.id,leaseToken,error instanceof DomainError ? error.code : "EMAIL_DELIVERY_FAILED",
         new Date(clock.now().getTime()+delayMs).toISOString(),MAX_EMAIL_ATTEMPTS,
         clock.now().toISOString()],
      );
      failed += 1;
    }
  }
  return { sent, failed };
}

export function trackerAccessToken(secret: string, subscriptionId: string): string {
  requireTrackerSecret(secret);
  return createHmac("sha256", secret)
    .update(`packproof:tracker:v1:${subscriptionId}`, "utf8")
    .digest("base64url");
}

function trackerViewUrl(baseUrl: string, secret: string, subscriptionId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/p/${trackerAccessToken(secret, subscriptionId)}`;
}

function requireTrackerSecret(secret: string): void {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new DomainError(
      "TRACKER_LINK_SIGNING_UNAVAILABLE",
      "Secure tracker email links are not configured",
      503,
    );
  }
}

function requireEmail(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("INVALID_EMAIL", "email is required", 400);
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DomainError("INVALID_EMAIL", "email must be a valid address", 400);
  }
  return email;
}

function requirePreference(value: unknown): NotificationPreference {
  if (value == null || value === "") return "IMPORTANT";
  if (typeof value !== "string" || !(NOTIFICATION_PREFERENCES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_NOTIFICATION_PREFERENCE", "notification preference is not allowed", 400);
  }
  return value as NotificationPreference;
}

async function enqueueOutbox(
  db: Database,
  now: Date,
  proofId: string,
  subscriptionId: string,
  eventKey: string,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO proof_notification_outbox (
       id, proof_id, subscription_id, event_key, created_at, next_attempt_at
     ) VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (subscription_id, event_key) DO NOTHING`,
    [newId("pno"), proofId, subscriptionId, eventKey, now.toISOString()],
  );
  return (result.rowCount ?? 0) > 0;
}

function parseMilestones(value: unknown): TrackerMilestoneCode[] {
  if (Array.isArray(value)) return value.filter((item): item is TrackerMilestoneCode => typeof item === "string") as TrackerMilestoneCode[];
  if (typeof value === "string") {
    try {
      return parseMilestones(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function shouldNotify(preference: NotificationPreference, code: TrackerMilestoneCode): boolean {
  if (preference === "ALL") return code !== "PROOF_CREATED";
  if (preference === "FINAL_ONLY") return code === "PROOF_FINALIZED";
  return [
    "PACKING_RECORDED",
    "PROOF_FINALIZED",
    "CARRIER_ACCEPTED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
  ].includes(code);
}

function toSubscriptionView(
  row: SubscriptionRow,
  publicWebBaseUrl: string,
  trackerLinkSecret: string,
): ProofEmailSubscriptionView {
  return {
    subscriptionId: row.id,
    proofId: row.proof_id,
    email: row.email,
    preference: row.preference,
    scope: row.scope,
    createdAt: toIso(row.created_at),
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : null,
    viewUrl: trackerViewUrl(publicWebBaseUrl, trackerLinkSecret, row.id),
  };
}

function emailForEvent(eventKey: string, tracker: ProofTrackerView, viewUrl: string, to: string) {
  const milestone = eventKey.startsWith("MILESTONE:") ? eventKey.slice("MILESTONE:".length) : null;
  const title = milestone ? milestoneEmailTitle(milestone as TrackerMilestoneCode) : "Your PackProof receipt is ready";
  const subject = milestone ? `PackProof update: ${title}` : "A PackProof receipt has been shared with you";
  const text = `${title}\n\nView the receipt: ${viewUrl}\n\nThis view-only link cannot change the Proof. Sign in to manage notification preferences. No response is not acceptance.`;
  const html = `<p>${escapeHtml(title)}</p><p><a href="${escapeHtml(viewUrl)}">View your PackProof receipt</a></p><p>This view-only link cannot change the Proof. Sign in to manage notification preferences. No response is not acceptance.</p>`;
  return { to, subject, text, html };
}

function milestoneEmailTitle(code: TrackerMilestoneCode): string {
  switch (code) {
    case "PROOF_CREATED": return "Proof created";
    case "PACKING_RECORDED": return "Packing evidence recorded";
    case "PROOF_FINALIZED": return "Evidence record finalized";
    case "CARRIER_ACCEPTED": return "Carrier accepted the package";
    case "IN_TRANSIT": return "Package in transit";
    case "OUT_FOR_DELIVERY": return "Package out for delivery";
    case "DELIVERED": return "Carrier reported delivery";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}


function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function copyReceiptGrant(db:Database,clock:Clock,actorUserId:string,proofId:string,targetLinkId:string,sourceLinkId:unknown):Promise<number|null> {
  if(typeof sourceLinkId!=="string"||sourceLinkId===targetLinkId) throw new DomainError("INVALID_DISCLOSURE","Select a shared Proof link",400);
  type Copied={scope_version:number,policy_version:string,purpose:string,fields:unknown,media:unknown,preview_hash:string};
  const source=(await db.query<Copied>(`SELECT g.* FROM proof_disclosure_grants g JOIN proof_access_links l ON l.id=g.access_link_id WHERE l.id=$1 AND l.proof_id=$2 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>$3) AND NOT EXISTS(SELECT 1 FROM proof_notification_subscriptions s WHERE s.access_link_id=l.id) ORDER BY g.scope_version DESC LIMIT 1`,[sourceLinkId,proofId,clock.now().toISOString()])).rows[0];
  if(!source||!["BUYER_RECEIPT","SHARED_PROOF"].includes(source.purpose))throw new DomainError("INVALID_DISCLOSURE","Select a current shared Proof link",409);
  const previous=(await db.query<Copied>("SELECT * FROM proof_disclosure_grants WHERE access_link_id=$1 ORDER BY scope_version DESC LIMIT 1",[targetLinkId])).rows[0];
  if(previous&&previous.policy_version===source.policy_version&&previous.purpose===source.purpose&&JSON.stringify(previous.fields)===JSON.stringify(source.fields)&&JSON.stringify(previous.media)===JSON.stringify(source.media)&&previous.preview_hash===source.preview_hash)return null;
  const version=Number(previous?.scope_version??0)+1;
  await db.query("INSERT INTO proof_disclosure_grants(access_link_id,scope_version,policy_version,purpose,fields,media,preview_hash,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)",[targetLinkId,version,source.policy_version,source.purpose,JSON.stringify(source.fields),JSON.stringify(source.media),source.preview_hash,actorUserId,clock.now().toISOString()]);
  return version;
}
