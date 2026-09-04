import express, { type Express, type Request, type Response } from "express";
import { createApp, type AppDependencies } from "./app.js";
import { DomainError } from "./domain/errors.js";
import { requireParticipant } from "./domain/proof-access.js";
import { resolveAccessToken } from "./domain/access-links.js";
import { appendAudit } from "./domain/audit.js";
import {
  createProofEmailSubscription,
  dispatchPendingProofEmails,
  listProofEmailSubscriptions,
  reconcileAllProofNotifications,
  revokeProofEmailSubscription,
  type NotificationPreference,
} from "./domain/proof-notifications.js";
import {
  handleEbayAccountDeletion,
  type EbayRuntime,
} from "./domain/ebay-marketplace.js";
import { MemoryCredentialStore } from "./integrations/memory-credential-store.js";
import {
  verifyEbayDeletionNotificationSignature,
  type EbayDeletionSignatureVerificationInput,
} from "./integrations/ebay/account-deletion.js";
import { parseEbayAppSecret } from "./integrations/ebay/credentials.js";
import { disabledEbayRuntime } from "./integrations/ebay/runtime.js";
import {
  createEmailDeliveryFromEnv,
  type EmailDelivery,
} from "./integrations/email/delivery.js";

export type EbayDeletionSignatureVerifier = (
  input: EbayDeletionSignatureVerificationInput,
) => Promise<void>;

export interface ServerAppDependencies extends AppDependencies {
  ebayDeletionSignatureVerifier?: EbayDeletionSignatureVerifier;
  emailDelivery?: EmailDelivery;
  trackerLinkSecret?: string;
}

/**
 * Production-facing application boundary.
 *
 * createApp remains the core HTTP router. Security-sensitive provider webhooks
 * and delivery-only concerns live here so they do not become authoritative
 * Proof state. Email notifications are projections of server-owned Proof and
 * shipment state; they can never mutate a Proof.
 */
export function createServerApp(deps: ServerAppDependencies): Express {
  const server = express();
  server.disable("x-powered-by");

  const credentialStore = deps.credentialStore ?? new MemoryCredentialStore();
  const ebay = deps.ebay ?? disabledEbayRuntime();
  const verifyDeletionSignature =
    deps.ebayDeletionSignatureVerifier ?? verifyEbayDeletionNotificationSignature;
  const emailDelivery = deps.emailDelivery ?? createEmailDeliveryFromEnv(process.env);
  const trackerLinkSecret =
    deps.trackerLinkSecret ??
    process.env.PACKPROOF_TRACKER_LINK_SECRET ??
    (deps.devAuth ? "packproof-development-tracker-link-secret-v1" : "");
  const publicWebBaseUrl =
    (deps.corsOrigins ?? []).find((origin) => origin.startsWith("http")) ?? deps.publicBaseUrl;

  server.post(
    "/integrations/webhooks/ebay/account-deletion",
    express.raw({ type: () => true, limit: "256kb" }),
    async (req, res) => {
      try {
        const payload = parseJsonWebhook(req);
        const runtime = requireDeletionVerificationRuntime(ebay);
        const clientSecret = parseEbayAppSecret(
          await credentialStore.getCredentials({
            adapterKey: "ebay",
            credentialReference: runtime.appCredentialReference,
          }),
        );

        await verifyDeletionSignature({
          payload,
          signatureHeader: req.header("X-EBAY-SIGNATURE"),
          environment: runtime.environment,
          clientId: runtime.clientId,
          clientSecret,
        });

        const result = await handleEbayAccountDeletion(
          deps.db,
          deps.clock,
          payload,
          credentialStore,
        );
        res.status(200).json(result);
      } catch (error) {
        sendBoundaryError(error, res);
      }
    },
  );

  server.post(
    "/proofs/:id/email-subscriptions",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      try {
        const actorUserId = await authenticateUser(deps, req);
        // Authorize before resolving tracker details so a nonparticipant cannot
        // use this endpoint to distinguish an existing private Proof from an
        // arbitrary id.
        await requireParticipant(deps.db, req.params.id, actorUserId);
        const subscription = await createProofEmailSubscription(
          deps.db,
          deps.clock,
          actorUserId,
          req.params.id,
          {
            email: req.body?.email,
            preference: req.body?.preference,
            scope: req.body?.scope,
            publicWebBaseUrl,
            trackerLinkSecret,
          },
        );
        const delivery = await dispatchPendingProofEmails(
          deps.db,
          deps.clock,
          emailDelivery,
          publicWebBaseUrl,
          trackerLinkSecret,
          req.params.id,
        );
        res.status(201).json({
          subscription,
          emailDeliveryConfigured: emailDelivery.enabled,
          delivery,
        });
      } catch (error) {
        sendBoundaryError(error, res);
      }
    },
  );

  server.get("/proofs/:id/email-subscriptions", async (req, res) => {
    try {
      const actorUserId = await authenticateUser(deps, req);
      const subscriptions = await listProofEmailSubscriptions(
        deps.db,
        actorUserId,
        req.params.id,
        publicWebBaseUrl,
        trackerLinkSecret,
      );
      res.json({ subscriptions, emailDeliveryConfigured: emailDelivery.enabled });
    } catch (error) {
      sendBoundaryError(error, res);
    }
  });

  server.delete("/proofs/:id/email-subscriptions/:subscriptionId", async (req, res) => {
    try {
      const actorUserId = await authenticateUser(deps, req);
      await revokeProofEmailSubscription(
        deps.db,
        deps.clock,
        actorUserId,
        req.params.id,
        req.params.subscriptionId,
      );
      res.status(204).end();
    } catch (error) {
      sendBoundaryError(error, res);
    }
  });

  server.get("/public/proofs/:token/email-subscription", async (req, res) => {
    try {
      const access = await resolveAccessToken(deps.db, deps.clock, req.params.token);
      const subscription = await findRecipientSubscription(deps, access.id);
      res.json({
        subscription: {
          email: maskEmail(subscription.email),
          preference: subscription.preference,
        },
      });
    } catch (error) {
      sendBoundaryError(error, res);
    }
  });

  server.patch(
    "/public/proofs/:token/email-subscription",
    express.json({ limit: "8kb" }),
    async (req, res) => {
      try {
        const preference = parseRecipientPreference(req.body?.preference);
        const access = await resolveAccessToken(deps.db, deps.clock, req.params.token);
        const subscription = await findRecipientSubscription(deps, access.id);
        const now = deps.clock.now();
        await deps.db.query(
          `UPDATE proof_notification_subscriptions
              SET preference = $2, updated_at = $3
            WHERE id = $1 AND revoked_at IS NULL`,
          [subscription.id, preference, now.toISOString()],
        );
        await appendAudit(deps.db, {
          proofId: access.proof_id,
          actorUserId: null,
          eventType: "PROOF_TRACKER_EMAIL_PREFERENCE_UPDATED",
          eventData: { subscriptionId: subscription.id, preference },
          at: now,
        });
        res.json({
          subscription: {
            email: maskEmail(subscription.email),
            preference,
          },
        });
      } catch (error) {
        sendBoundaryError(error, res);
      }
    },
  );

  server.delete("/public/proofs/:token/email-subscription", async (req, res) => {
    try {
      const access = await resolveAccessToken(deps.db, deps.clock, req.params.token);
      const subscription = await findRecipientSubscription(deps, access.id);
      const now = deps.clock.now();
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE proof_notification_subscriptions
              SET revoked_at = $2, updated_at = $2
            WHERE id = $1 AND revoked_at IS NULL`,
          [subscription.id, now.toISOString()],
        );
        await tx.query(
          `UPDATE proof_notification_outbox
              SET cancelled_at = $2
            WHERE subscription_id = $1
              AND sent_at IS NULL
              AND cancelled_at IS NULL`,
          [subscription.id, now.toISOString()],
        );
        await appendAudit(tx, {
          proofId: access.proof_id,
          actorUserId: null,
          eventType: "PROOF_TRACKER_EMAIL_UNSUBSCRIBED",
          eventData: { subscriptionId: subscription.id },
          at: now,
        });
      });
      // Recipient unsubscribe stops future email only. The secure view-only
      // Proof link remains valid unless a Proof participant separately revokes it.
      res.status(204).end();
    } catch (error) {
      sendBoundaryError(error, res);
    }
  });

  // Reconcile notification projections after successful mutations and at most
  // once per minute on ordinary traffic. The database outbox makes delivery
  // retryable; load-balancer health traffic is enough to retry a transient SMTP
  // failure even when no user is actively changing a Proof.
  let lastMaintenanceAt = 0;
  server.use((req, res, next) => {
    const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    const due = Date.now() - lastMaintenanceAt >= 60_000;
    if (due) lastMaintenanceAt = Date.now();
    res.on("finish", () => {
      if (res.statusCode >= 400 || (!mutation && !due)) return;
      void runNotificationMaintenance(
        deps,
        emailDelivery,
        publicWebBaseUrl,
        trackerLinkSecret,
      ).catch((error) => console.error("PackProof notification maintenance failed", error));
    });
    next();
  });

  server.use(
    createApp({
      ...deps,
      credentialStore,
      ebay,
    }),
  );

  return server;
}

async function findRecipientSubscription(
  deps: ServerAppDependencies,
  accessLinkId: string,
): Promise<{ id: string; email: string; preference: NotificationPreference }> {
  const found = await deps.db.query<{
    id: string;
    email: string;
    preference: NotificationPreference;
  }>(
    `SELECT id, email, preference
       FROM proof_notification_subscriptions
      WHERE access_link_id = $1 AND revoked_at IS NULL`,
    [accessLinkId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new DomainError(
      "NOTIFICATION_SUBSCRIPTION_NOT_FOUND",
      "Email updates are not active for this viewing link",
      404,
    );
  }
  return row;
}

function parseRecipientPreference(value: unknown): NotificationPreference {
  if (value === "IMPORTANT" || value === "ALL" || value === "FINAL_ONLY") {
    return value;
  }
  throw new DomainError(
    "INVALID_NOTIFICATION_PREFERENCE",
    "notification preference is not allowed",
    400,
  );
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length))}${local.length > 2 ? "•••" : ""}@${domain}`;
}

async function runNotificationMaintenance(
  deps: ServerAppDependencies,
  emailDelivery: EmailDelivery,
  publicWebBaseUrl: string,
  trackerLinkSecret: string,
): Promise<void> {
  if (!trackerLinkSecret) return;
  await reconcileAllProofNotifications(deps.db, deps.clock);
  await dispatchPendingProofEmails(
    deps.db,
    deps.clock,
    emailDelivery,
    publicWebBaseUrl,
    trackerLinkSecret,
  );
}

async function authenticateUser(deps: AppDependencies, req: Request): Promise<string> {
  const auth = await deps.auth.authenticate(req.headers);
  if (!auth?.userId) throw new DomainError("UNAUTHENTICATED", "Missing bearer token", 401);
  return auth.userId;
}

function requireDeletionVerificationRuntime(runtime: EbayRuntime): EbayRuntime & {
  clientId: string;
  appCredentialReference: string;
} {
  if (!runtime.enabled) {
    throw new DomainError("EBAY_INTEGRATION_DISABLED", "eBay integration is not enabled", 403);
  }
  if (!runtime.clientId || !runtime.appCredentialReference) {
    throw new DomainError(
      "WEBHOOK_VERIFICATION_UNAVAILABLE",
      "eBay webhook verification credentials are not configured",
      503,
    );
  }
  return runtime as EbayRuntime & { clientId: string; appCredentialReference: string };
}

function parseJsonWebhook(req: Request): unknown {
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
  try {
    return JSON.parse(body || "{}") as unknown;
  } catch {
    throw new DomainError("INVALID_WEBHOOK", "eBay deletion notification is invalid", 400);
  }
}

function sendBoundaryError(error: unknown, res: Response): void {
  if (error instanceof DomainError) {
    res.status(error.httpStatus).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(error);
  res.status(500).json({
    error: { code: "INTERNAL", message: "Internal server error" },
  });
}
