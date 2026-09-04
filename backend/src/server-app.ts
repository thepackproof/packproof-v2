import express, { type Express, type Request, type Response } from "express";
import { createApp, type AppDependencies } from "./app.js";
import { DomainError } from "./domain/errors.js";
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

export type EbayDeletionSignatureVerifier = (
  input: EbayDeletionSignatureVerificationInput,
) => Promise<void>;

export interface ServerAppDependencies extends AppDependencies {
  ebayDeletionSignatureVerifier?: EbayDeletionSignatureVerifier;
}

/**
 * Production-facing application boundary.
 *
 * createApp remains the core HTTP router. Security-sensitive provider webhooks
 * are intercepted here before they can reach any mutation route. Keeping the
 * boundary thin lets us harden integrations without coupling provider
 * authentication to the already-large core router while it is being split.
 */
export function createServerApp(deps: ServerAppDependencies): Express {
  const server = express();
  server.disable("x-powered-by");

  const credentialStore = deps.credentialStore ?? new MemoryCredentialStore();
  const ebay = deps.ebay ?? disabledEbayRuntime();
  const verifyDeletionSignature =
    deps.ebayDeletionSignatureVerifier ?? verifyEbayDeletionNotificationSignature;

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

  server.use(
    createApp({
      ...deps,
      credentialStore,
      ebay,
    }),
  );

  return server;
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
