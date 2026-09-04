import express, { type Express, type Request, type Response } from "express";
import { createApp, type AppDependencies } from "./app.js";
import { DomainError } from "./domain/errors.js";
import {
  createProofEmailSubscription,
  dispatchPendingProofEmails,
  listProofEmailSubscriptions,
  reconcileAllProofNotifications,
  revokeProofEmailSubscription,
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
