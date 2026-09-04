import { createHmac } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import type { EmailDelivery } from "../integrations/email/delivery.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import { requireParticipant } from "./proof-access.js";
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
  },
): Promise<ProofEmailSubscriptionView> {
  const email = requireEmail(input.email);
  const normalized = email.toLowerCase();
  const preference = requirePreference(input.preference);
  const scope = requireAccessLinkScope(input.scope);
  requireTrackerSecret(input.trackerLinkSecret);

  return db.transaction(async (tx) => {
    const participant = await requireParticipant(tx, proofId, actorUserId);
    // Serialize create-or-get for the same Proof, including across API instances.
    await tx.query(`SELECT id FROM proofs WHERE id = $1 FOR UPDATE`, [proofId]);
    const tracker = await buildProofTracker(tx, proofId);
    const baseline = tracker.milestones
      .filter((milestone) => milestone.state === "COMPLETE")
      .map((milestone) => milestone.code);
    const existing = await tx.query<SubscriptionRow>(
      `SELECT * FROM proof_notification_subscriptions
        WHERE proof_id = $1 AND email_normalized = $2 AND revoked_at IS NULL`,
      [proofId, normalized],
    );
    if (existing.rows[0]) {
      return toSubscriptionView(existing.rows[0], input.publicWebBaseUrl, input.trackerLinkSecret);
    }

    const now = clock.now();
    const subscriptionId = newId("pns");
    const accessLinkId = newId("pal");
    const token = trackerAccessToken(input.trackerLinkSecret, subscriptionId);
    const tokenHash = sha256Hex(token);

    await tx.query(
      `INSERT INTO proof_access_links (
         id, proof_id, token_hash, scope, created_by_participant_id, recipient_hint,
         created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [accessLinkId, proofId, tokenHash, scope, participant.id, email, now.toISOString()],
    );
    await tx.query(
      `INSERT INTO proof_notification_subscriptions (
         id, proof_id, email, email_normalized, preference, scope, access_link_id,
         created_by_user_id, processed_milestones, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)`,
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
      ],
    );
    await enqueueOutbox(tx, now, proofId, subscriptionId, "TRACKER_SHARED");
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "PROOF_TRACKER_EMAIL_SUBSCRIBED",
      eventData: { subscriptionId, accessLinkId, preference, scope, recipientHint: email },
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

export async function dispatchPendingProofEmails(
  db: Database,
  clock: Clock,
  emailDelivery: EmailDelivery,
  publicWebBaseUrl: string,
  trackerLinkSecret: string,
  proofId?: string,
): Promise<{ sent: number; failed: number }> {
  requireTrackerSecret(trackerLinkSecret);
  if (!emailDelivery.enabled) return { sent: 0, failed: 0 };
  const now = clock.now();
  const params: unknown[] = [now.toISOString()];
  let proofClause = "";
  if (proofId) {
    params.push(proofId);
    proofClause = ` AND o.proof_id = $${params.length}`;
  }
  const pending = await db.query<OutboxRow>(
    `SELECT o.id, o.proof_id, o.subscription_id, o.event_key, o.attempt_count,
            s.email, s.preference, s.scope, s.revoked_at
       FROM proof_notification_outbox o
       JOIN proof_notification_subscriptions s ON s.id = o.subscription_id
       JOIN proof_access_links l ON l.id = s.access_link_id
      WHERE o.sent_at IS NULL
        AND o.cancelled_at IS NULL
        AND o.next_attempt_at <= $1
        AND (o.delivery_lease_until IS NULL OR o.delivery_lease_until <= $1)
        AND o.attempt_count < 8
        AND s.revoked_at IS NULL
        AND l.revoked_at IS NULL
        AND (l.expires_at IS NULL OR l.expires_at > $1)${proofClause}
      ORDER BY o.created_at ASC, o.id ASC
      LIMIT 25`,
    params,
  );
  let sent = 0;
  let failed = 0;
  for (const row of pending.rows) {
    const claimedAt = clock.now();
    const token = newId("delivery");
    const claimed = await db.query<{ attempt_count: number }>(
      `UPDATE proof_notification_outbox o
          SET delivery_token = $2, delivery_lease_until = $4,
              attempt_count = attempt_count + 1
        WHERE o.id = $1 AND o.sent_at IS NULL AND o.cancelled_at IS NULL
          AND o.next_attempt_at <= $3 AND o.attempt_count < 8
          AND (o.delivery_lease_until IS NULL OR o.delivery_lease_until <= $3)
          AND EXISTS (
            SELECT 1 FROM proof_notification_subscriptions s
            JOIN proof_access_links l ON l.id = s.access_link_id
            WHERE s.id = o.subscription_id AND s.revoked_at IS NULL
              AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > $3)
          )
        RETURNING attempt_count`,
      [row.id, token, claimedAt.toISOString(), new Date(claimedAt.getTime() + 5 * 60_000).toISOString()],
    );
    if (!claimed.rows[0]) continue;
    try {
      // Recheck preferences and revocation after claiming, before external delivery.
      const active = await db.query<{ preference: NotificationPreference }>(
        `SELECT s.preference FROM proof_notification_subscriptions s
         JOIN proof_notification_outbox o ON o.subscription_id = s.id
         JOIN proof_access_links l ON l.id = s.access_link_id
         WHERE o.id = $1 AND o.delivery_token = $2 AND o.cancelled_at IS NULL
           AND s.revoked_at IS NULL AND l.revoked_at IS NULL
           AND (l.expires_at IS NULL OR l.expires_at > $3)`,
        [row.id, token, clock.now().toISOString()],
      );
      const preference = active.rows[0]?.preference;
      const milestone = row.event_key.startsWith("MILESTONE:")
        ? row.event_key.slice("MILESTONE:".length) as TrackerMilestoneCode : null;
      if (!preference || (milestone && !shouldNotify(preference, milestone))) {
        await db.query(
          `UPDATE proof_notification_outbox SET cancelled_at = $3,
             delivery_token = NULL, delivery_lease_until = NULL
           WHERE id = $1 AND delivery_token = $2`,
          [row.id, token, clock.now().toISOString()],
        );
        continue;
      }
      const tracker = await buildProofTracker(db, row.proof_id);
      const viewUrl = trackerViewUrl(publicWebBaseUrl, trackerLinkSecret, row.subscription_id);
      const message = emailForEvent(row.event_key, tracker, viewUrl, row.email);
      await emailDelivery.send(message);
      await db.query(
        `UPDATE proof_notification_outbox
            SET sent_at = $3, last_error = NULL,
                delivery_token = NULL, delivery_lease_until = NULL
          WHERE id = $1 AND delivery_token = $2 AND sent_at IS NULL`,
        [row.id, token, clock.now().toISOString()],
      );
      sent += 1;
    } catch {
      const attempts = Number(claimed.rows[0].attempt_count);
      const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts - 1, 7));
      const nextAttempt = new Date(clock.now().getTime() + delayMs).toISOString();
      await db.query(
        `UPDATE proof_notification_outbox
            SET last_error = 'Email delivery failed', next_attempt_at = $3,
                delivery_token = NULL, delivery_lease_until = NULL
          WHERE id = $1 AND delivery_token = $2 AND sent_at IS NULL`,
        [row.id, token, nextAttempt],
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
  const reference = tracker.reference ? ` ${tracker.reference}` : "";
  const milestone = eventKey.startsWith("MILESTONE:") ? eventKey.slice("MILESTONE:".length) : null;
  const title = milestone ? milestoneEmailTitle(milestone as TrackerMilestoneCode) : "Your PackProof tracker is ready";
  const subject = milestone ? `PackProof update: ${title}` : "A PackProof record has been shared with you";
  const text = [
    title,
    "",
    `PackProof${reference} is ${tracker.headline.toLowerCase()}.`,
    tracker.itemTitle ? `Item: ${tracker.itemTitle}` : null,
    "",
    `View the live Proof: ${viewUrl}`,
    "",
    "This secure link is view-only. It cannot alter the Proof.",
  ].filter(Boolean).join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033"><h2>${escapeHtml(title)}</h2><p>PackProof${escapeHtml(reference)} is <strong>${escapeHtml(tracker.headline.toLowerCase())}</strong>.</p>${tracker.itemTitle ? `<p>Item: ${escapeHtml(tracker.itemTitle)}</p>` : ""}<p><a href="${escapeHtml(viewUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#155eef;color:white;text-decoration:none;font-weight:600">View live Proof</a></p><p style="color:#667085;font-size:13px">This secure link is view-only. It cannot alter the Proof.</p></div>`;
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
    case "DELIVERED": return "Package delivered";
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
