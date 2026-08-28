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
import { acceptInvitation, createInvitation } from "./domain/invitations.js";
import { getProofForUser } from "./domain/proofs.js";
import { createTransaction, getTransaction } from "./domain/transactions.js";
import { ensureIdentityUser } from "./domain/users.js";
import type { ObjectStore } from "./s3/object-store.js";

export interface AppDependencies {
  db: Database;
  objectStore: ObjectStore;
  clock: Clock;
  auth: AuthenticationAdapter;
  publicBaseUrl: string;
  devAuth: boolean;
}

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
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
      const result = await createTransaction(deps.db, deps.clock, bearerUser(req), {
        externalReference: req.body?.externalReference ?? null,
        metadata: req.body?.metadata ?? {},
      });
      res.status(201).json(result);
    }),
  );

  app.get(
    "/transactions/:id",
    asyncRoute(async (req, res) => {
      const result = await getTransaction(deps.db, bearerUser(req), req.params.id);
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

  app.post(
    "/proofs/:id/invitations",
    asyncRoute(async (req, res) => {
      const result = await createInvitation(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        String(req.body?.inviteeIdentifier ?? ""),
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
