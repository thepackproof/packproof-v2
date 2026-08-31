import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { AuthenticationAdapter } from "./auth/adapter.js";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
import { createOrGetProof } from "./domain/create-proof.js";
import { DomainError, errorCodeFromSql } from "./domain/errors.js";
import {
  commitEvidence,
  initializeEvidenceUpload,
} from "./domain/evidence.js";
import { finalizeProof, getManifest } from "./domain/finalize.js";
import {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
} from "./domain/invitations.js";
import { commitAttestation } from "./domain/attestations.js";
import { listMyProofs } from "./domain/proof-collection.js";
import { getProfile, searchUsers, updateProfile } from "./domain/profiles.js";
import { getProofForUser } from "./domain/proofs.js";
import {
  createTransaction,
  getTransaction,
  loadTransactionBundle,
  updateShipping,
  updateTransaction,
} from "./domain/transactions.js";
import { ensureIdentityUser } from "./domain/users.js";
import { importNormalizedTransaction } from "./domain/transaction-import.js";
import {
  importShipmentObservations,
  listShipmentEventsForTransaction,
  recordParticipantShipmentEvent,
  resolveTransactionIdForShipmentImport,
  sliceTimelineThrough,
} from "./domain/shipment-events.js";
import type { ObjectStore } from "./s3/object-store.js";
import type { IntegrationAdapterRegistry } from "./integrations/registry.js";
import { createDefaultIntegrationRegistry } from "./integrations/registry.js";
import { parseIntegrationImportRequest } from "./integrations/import-request.js";
import { parseShipmentImportRequest } from "./integrations/shipment-import-request.js";

export interface AppDependencies {
  db: Database;
  objectStore: ObjectStore;
  clock: Clock;
  auth: AuthenticationAdapter;
  publicBaseUrl: string;
  devAuth: boolean;
  corsOrigins?: string[];
  integrations?: IntegrationAdapterRegistry;
}

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
}

function headerOrigin(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function bearerUser(req: Request): string {
  const userId = req.packproofUserId;
  if (!userId) {
    throw new DomainError("UNAUTHENTICATED", "Missing bearer token", 401);
  }
  return userId;
}

declare global {
  namespace Express {
    interface Request {
      packproofUserId?: string;
    }
  }
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  const corsOrigins = deps.corsOrigins ?? [];
  const integrations = deps.integrations ?? createDefaultIntegrationRegistry(deps.clock);
  app.use((req, res, next) => {
    const origin = headerOrigin(req.headers.origin);
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Idempotency-Key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(
    express.raw({
      type: ["application/octet-stream", "video/*", "image/*", "audio/*"],
      limit: "100mb",
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.devAuth) {
    app.post(
      "/auth/dev/login",
      asyncRoute(async (req, res) => {
        const subject = String(req.body?.subject ?? "").trim();
        if (!subject) {
          throw new DomainError("INVALID_SUBJECT", "subject is required", 400);
        }
        const userId = await ensureIdentityUser(
          deps.db,
          deps.clock,
          "dev",
          subject,
        );
        res.json({ userId, token: userId });
      }),
    );
  }

  app.put(
    "/upload/:token",
    asyncRoute(async (req, res) => {
      const body = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : "");
      const contentType = req.header("content-type") ?? undefined;
      const result = await deps.objectStore.putUpload(
        req.params.token,
        body,
        contentType,
      );
      res.json({ objectKey: result.key });
    }),
  );

  app.use((req, _res, next) => {
    if (
      req.path === "/health" ||
      req.path.startsWith("/auth/") ||
      req.path.startsWith("/upload/")
    ) {
      next();
      return;
    }
    deps.auth
      .authenticate(req.headers)
      .then((auth) => {
        req.packproofUserId = auth.userId;
        next();
      })
      .catch(next);
  });

  app.post(
    "/transactions",
    asyncRoute(async (req, res) => {
      const result = await createTransaction(deps.db, deps.clock, bearerUser(req), req.body);
      res.status(201).json(result);
    }),
  );

  app.post(
    "/integrations/transactions/import",
    asyncRoute(async (req, res) => {
      const parsed = parseIntegrationImportRequest(req.body);
      const adapter = integrations.get(parsed.adapterKey);
      if (adapter.kind !== "reference") {
        throw new DomainError(
          "INTEGRATION_TRUST_BOUNDARY",
          "This route accepts reference adapters only",
          403,
        );
      }
      const imported = await adapter.fetchPurchase({
        externalTransactionId: parsed.externalTransactionId,
      });
      const result = await importNormalizedTransaction(
        deps.db,
        deps.clock,
        bearerUser(req),
        imported,
        {
          createProof: parsed.createProof,
          adapterKey: adapter.adapterKey,
        },
      );
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.post(
    "/integrations/shipment-events/import",
    asyncRoute(async (req, res) => {
      const parsed = parseShipmentImportRequest(req.body);
      const adapter = integrations.getShipment(parsed.adapterKey);
      if (adapter.kind !== "reference") {
        throw new DomainError(
          "INTEGRATION_TRUST_BOUNDARY",
          "This route accepts reference adapters only",
          403,
        );
      }
      const actor = bearerUser(req);
      const transactionId = await resolveTransactionIdForShipmentImport(deps.db, actor, {
        transactionId: parsed.transactionId,
        externalTransactionId: parsed.externalTransactionId,
      });
      const bundle = await loadTransactionBundle(deps.db, transactionId);
      const observations = await adapter.fetchShipmentEvents({
        transactionId,
        trackingNumber: bundle?.shipping?.tracking_number ?? null,
        externalTransactionId: parsed.externalTransactionId,
        throughEventType: parsed.throughEventType,
      });
      const sliced = sliceTimelineThrough(observations, parsed.throughEventType);
      const result = await importShipmentObservations(
        deps.db,
        deps.clock,
        actor,
        transactionId,
        sliced,
      );
      res.status(result.createdCount > 0 ? 201 : 200).json(result);
    }),
  );

  app.get(
    "/transactions/:id",
    asyncRoute(async (req, res) => {
      const result = await getTransaction(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  app.get(
    "/transactions/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const transaction = await getTransaction(deps.db, bearerUser(req), req.params.id);
      const events = await listShipmentEventsForTransaction(deps.db, transaction.transactionId);
      res.json({
        transactionId: transaction.transactionId,
        proofId: transaction.proofId,
        identity: transaction.shipping,
        events,
      });
    }),
  );

  app.post(
    "/transactions/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const result = await recordParticipantShipmentEvent(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.patch(
    "/transactions/:id/shipping",
    asyncRoute(async (req, res) => {
      const result = await updateShipping(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.json(result);
    }),
  );

  app.patch(
    "/transactions/:id",
    asyncRoute(async (req, res) => {
      const result = await updateTransaction(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.json(result);
    }),
  );

  app.post(
    "/transactions/:id/proof",
    asyncRoute(async (req, res) => {
      const result = await createOrGetProof(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
      );
      res.json(result);
    }),
  );

  app.get(
    "/proofs/:id",
    asyncRoute(async (req, res) => {
      const result = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  app.get(
    "/proofs/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const proof = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json(proof.shipmentObservations);
    }),
  );

  app.get(
    "/proofs/:id/chronology",
    asyncRoute(async (req, res) => {
      const proof = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json({ proofId: proof.proofId, chronology: proof.chronology });
    }),
  );

  app.get(
    "/me",
    asyncRoute(async (req, res) => {
      const result = await getProfile(deps.db, bearerUser(req));
      res.json(result);
    }),
  );

  app.get(
    "/me/proofs",
    asyncRoute(async (req, res) => {
      const proofs = await listMyProofs(deps.db, bearerUser(req));
      res.json({ proofs });
    }),
  );

  app.patch(
    "/me/profile",
    asyncRoute(async (req, res) => {
      const result = await updateProfile(deps.db, deps.clock, bearerUser(req), {
        username: req.body?.username,
        displayName: req.body?.displayName,
      });
      res.json(result);
    }),
  );

  app.get(
    "/users/search",
    asyncRoute(async (req, res) => {
      const result = await searchUsers(deps.db, req.query.q);
      res.json({ users: result });
    }),
  );

  app.get(
    "/invitations",
    asyncRoute(async (req, res) => {
      const result = await listPendingInvitations(deps.db, bearerUser(req));
      res.json({ invitations: result });
    }),
  );

  app.post(
    "/proofs/:id/invitations",
    asyncRoute(async (req, res) => {
      const result = await createInvitation(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        {
          inviteeIdentifier:
            req.body?.inviteeIdentifier == null
              ? undefined
              : String(req.body.inviteeIdentifier),
          inviteeUserId:
            req.body?.inviteeUserId == null ? undefined : String(req.body.inviteeUserId),
        },
      );
      res.status(201).json(result);
    }),
  );

  app.post(
    "/invitations/:token/accept",
    asyncRoute(async (req, res) => {
      const result = await acceptInvitation(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.token,
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/evidence/uploads",
    asyncRoute(async (req, res) => {
      const idempotencyKey = String(
        req.header("idempotency-key") ?? req.body?.idempotencyKey ?? "",
      );
      const result = await initializeEvidenceUpload(
        deps.db,
        deps.clock,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
        {
          contentType: String(req.body?.contentType ?? ""),
          evidenceType: req.body?.evidenceType,
          idempotencyKey,
        },
      );
      res.status(201).json(result);
    }),
  );

  app.post(
    "/proofs/:id/evidence/:evidenceId/commit",
    asyncRoute(async (req, res) => {
      const result = await commitEvidence(
        deps.db,
        deps.clock,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
        req.params.evidenceId,
        req.body?.sha256,
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/attestations",
    asyncRoute(async (req, res) => {
      const result = await commitAttestation(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        {
          statement: req.body?.statement == null ? undefined : String(req.body.statement),
          relatedEvidenceId:
            req.body?.relatedEvidenceId == null ? undefined : String(req.body.relatedEvidenceId),
        },
      );
      res.status(201).json(result);
    }),
  );

  app.post(
    "/proofs/:id/finalize",
    asyncRoute(async (req, res) => {
      const result = await finalizeProof(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
      );
      res.json(result);
    }),
  );

  app.get(
    "/proofs/:id/manifest",
    asyncRoute(async (req, res) => {
      const result = await getManifest(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof DomainError) {
      res.status(error.httpStatus).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    const sqlCode = errorCodeFromSql(error);
    if (sqlCode) {
      const status = sqlCode === "PROOF_ALREADY_FINALIZED" ? 409 : 409;
      res.status(status).json({
        error: { code: sqlCode, message: error instanceof Error ? error.message : sqlCode },
      });
      return;
    }
    console.error(error);
    res.status(500).json({
      error: { code: "INTERNAL", message: "Internal server error" },
    });
  };
  app.use(errors);

  return app;
}
