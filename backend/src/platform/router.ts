import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import type { AppDependencies } from "../app.js";
import type { Database } from "../db/database.js";
import { DomainError, errorCodeFromSql } from "../domain/errors.js";
import { createTransaction } from "../domain/transactions.js";
import { createOrGetProof } from "../domain/create-proof.js";
import { getProofForUser, getProofView, type ProofView } from "../domain/proofs.js";
import {
  initializeEvidenceUpload,
  commitEvidence,
  readCommittedEvidence,
} from "../domain/evidence.js";
import { commitAttestation } from "../domain/attestations.js";
import { createInvitation } from "../domain/invitations.js";
import { createAccessLink } from "../domain/access-links.js";
import { finalizeProof, getManifest } from "../domain/finalize.js";
import { appendAudit } from "../domain/audit.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import {
  API_SCOPES,
  authenticateApiKey,
  consumeApiRate,
  createTenant,
  issueApiKey,
  requireScope,
  requireTenantOwner,
  requireTenantProof,
  revokeApiKey,
  record,
  textField,
  type ApiPrincipal,
  type ApiScope,
} from "./tenants.js";
import { idempotent } from "./idempotency.js";
import {
  createWebhook,
  listEvents,
  listWebhooks,
  revokeWebhook,
  webhookConfigFromEnv,
  protectWebhookResponse,
  rotateWebhookSecret,
  retryWebhookDelivery,
} from "./webhooks.js";
import { previewOrderIntake } from "../intake/order-intake.js";
import { exportEvidencePackage, getEvidenceReview } from "../domain/evidence-review.js";
import {
  discardStageEvidence,
  acceptCommerceReceiver,
  commitStageEvidence,
  createCommerceStage,
  finalizeCommerceStage,
  initializeStageEvidence,
  inviteCommerceReceiver,
  listCommerceStages,
  requireCommerceAccess,
} from "../domain/commerce-lifecycle.js";
import {
  listUploadParts,
  storeUploadPart,
  completeUploadParts,
  discardPendingUpload,
} from "../domain/resumable-upload.js";
import {
  getRetentionControls,
  createRetentionHold,
  releaseRetentionHold,
  requestProofDeletion,
} from "../domain/retention-controls.js";

type ApiRequest = Request & {
  apiPrincipal?: ApiPrincipal;
  apiRequestId?: string;
};
const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
export function createPlatformRouter(deps: AppDependencies) {
  const router = express.Router();
  router.get("/openapi.json", (_req, res) =>
    res.sendFile(fileURLToPath(new URL("../../openapi.json", import.meta.url))),
  );
  const webBase = (deps.corsOrigins?.[0] ?? deps.publicBaseUrl).replace(/\/$/, "");
  const config = deps.webhookConfig ?? webhookConfigFromEnv();
  // API keys never authenticate first-party routes; user tokens never authenticate /v1.
  router.use((req: ApiRequest, res, next) => {
    req.apiRequestId = newId("req");
    res.setHeader("X-Request-Id", req.apiRequestId);
    res.setHeader("PackProof-API-Version", "v1");
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      req.apiPrincipal = await authenticateApiKey(deps.db, req.header("authorization"));
      const remaining = await consumeApiRate(deps.db, deps.clock, req.apiPrincipal.tenantId);
      res.setHeader("X-RateLimit-Limit", "120");
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      next();
    })().catch(next);
  });
  function endpoint(
    method: "get" | "post" | "delete",
    path: string,
    scope: ApiScope,
    fn: (db: Database, p: ApiPrincipal, req: Request) => Promise<unknown>,
    status = 200,
  ) {
    router[method](
      path,
      route(async (raw, res) => {
        const req = raw as ApiRequest;
        const principal = req.apiPrincipal!;
        requireScope(principal, scope);
        if (req.params.id) await requireTenantProof(deps.db, principal, req.params.id);
        let value: unknown;
        if (method === "get") value = await fn(deps.db, principal, req);
        else {
          const result = await idempotent(
            deps.db,
            deps.clock,
            principal.tenantId,
            `${method.toUpperCase()} ${req.path}`,
            req.header("Idempotency-Key"),
            req.body,
            (tx) => fn(tx, principal, req),
            path.startsWith("/webhooks") && method === "post"
              ? protectWebhookResponse(
                  `${principal.tenantId}:${req.path}:${req.header("Idempotency-Key")}`,
                  config,
                )
              : undefined,
          );
          res.setHeader("Idempotency-Replayed", String(result.replayed));
          value = result.value;
        }
        await auditRequest(deps.db, deps, req, `${method.toUpperCase()} ${path}`, status);
        res.status(status).json(value);
      }),
    );
  }
  function envelope(proof: ProofView, externalId: string) {
    return {
      apiVersion: "v1",
      externalId,
      proof,
      links: {
        self: `/v1/proofs/${proof.proofId}`,
        capture: `${webBase}/proofs/${proof.proofId}`,
        viewer: `${webBase}/proofs/${proof.proofId}`,
        manifest: `/v1/proofs/${proof.proofId}/manifest`,
      },
    };
  }
  endpoint(
    "post",
    "/proofs",
    "proofs:write",
    async (db, p, req) => {
      const body = record(req.body);
      const externalId = textField(body.externalId, "externalId", 200);
      const transaction = record(body.transaction);
      textField(transaction.itemTitle, "transaction.itemTitle", 200);
      if (
        body.status !== undefined ||
        body.tenantId !== undefined ||
        body.sellerUserId !== undefined ||
        transaction.createdBy !== undefined
      )
        throw new DomainError(
          "INVALID_REQUEST",
          "Identity and Proof status are assigned by the server",
          400,
        );
      const hash = sha256Hex(
        canonicalize({
          transaction,
          participationPolicy: body.participationPolicy ?? "COUNTERPARTY_OPTIONAL",
        }),
      );
      // Serialize create-or-get by tenant to preserve external identity under races.
      await db.query("SELECT id FROM api_tenants WHERE id=$1 FOR UPDATE", [p.tenantId]);
      const found = await db.query<{ proof_id: string; request_hash: string }>(
        "SELECT proof_id,request_hash FROM api_tenant_proofs WHERE tenant_id=$1 AND external_id=$2",
        [p.tenantId, externalId],
      );
      if (found.rows[0]) {
        if (found.rows[0].request_hash !== hash)
          throw new DomainError(
            "EXTERNAL_ID_CONFLICT",
            "This order ID is already bound to a different request",
            409,
          );
        return envelope(await getProofForUser(db, p.userId, found.rows[0].proof_id), externalId);
      }
      // External identity belongs to api_tenant_proofs, not the legacy global
      // external_reference namespace. The confirmed source is retained as metadata.
      const txn = await createTransaction(db, deps.clock, p.userId, {
        ...transaction,
        externalReference: null,
        metadata: {
          source: "partner_api",
          tenantId: p.tenantId,
          externalId,
          environment: p.environment,
          sourceMetadata: transaction.metadata ?? {},
        },
      });
      const proof = await createOrGetProof(db, deps.clock, p.userId, txn.transactionId, {
        participationPolicy: body.participationPolicy as
          | "COUNTERPARTY_OPTIONAL"
          | "COUNTERPARTY_REQUIRED"
          | undefined,
      });
      await db.query(
        "INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES ($1,$2,$3,$4,$5)",
        [p.tenantId, externalId, proof.proofId, hash, deps.clock.now().toISOString()],
      );
      return envelope(proof, externalId);
    },
    201,
  );
  endpoint("get", "/proofs", "proofs:read", async (db, p, req) => {
    const after = req.query.after == null ? "" : textField(req.query.after, "after", 100);
    const found = await db.query<{ proof_id: string; external_id: string }>(
      "SELECT proof_id,external_id FROM api_tenant_proofs WHERE tenant_id=$1 AND proof_id>$2 ORDER BY proof_id LIMIT 51",
      [p.tenantId, after],
    );
    const page = found.rows.slice(0, 50);
    return {
      proofs: await Promise.all(
        page.map(async (r) =>
          envelope(await getProofForUser(db, p.userId, r.proof_id), r.external_id),
        ),
      ),
      nextCursor: page.at(-1)?.proof_id ?? after,
      hasMore: found.rows.length > 50,
    };
  });
  endpoint("get", "/proofs/:id", "proofs:read", async (db, p, req) => {
    const binding = await requireTenantProof(db, p, req.params.id);
    await appendAudit(db, {
      proofId: req.params.id,
      actorUserId: p.userId,
      eventType: "PROOF_ACCESSED",
      eventData: { channel: "partner_api", keyId: p.keyId },
      at: deps.clock.now(),
    });
    return envelope(await getProofForUser(db, p.userId, req.params.id), binding.external_id);
  });
  endpoint(
    "post",
    "/proofs/:id/participants",
    "participants:write",
    (db, p, req) =>
      createInvitation(db, deps.clock, p.userId, req.params.id, {
        inviteeUserId: textField(req.body?.userId, "userId"),
      }),
    201,
  );
  endpoint(
    "post",
    "/proofs/:id/evidence",
    "evidence:write",
    (db, p, req) =>
      initializeEvidenceUpload(db, deps.clock, deps.objectStore, p.userId, req.params.id, {
        contentType: textField(req.body?.contentType, "contentType", 100),
        evidenceType: req.body?.evidenceType,
        idempotencyKey: sha256Hex(`${p.tenantId}:${req.header("Idempotency-Key")}`),
      }),
    201,
  );
  endpoint("post", "/proofs/:id/evidence/:evidenceId/commit", "evidence:write", (db, p, req) =>
    commitEvidence(
      db,
      deps.clock,
      deps.objectStore,
      p.userId,
      req.params.id,
      req.params.evidenceId,
      req.body?.sha256,
    ),
  );
  endpoint("get", "/proofs/:id/evidence/:evidenceId/parts", "evidence:write", (db, p, req) =>
    listUploadParts(db, p.userId, req.params.id, req.params.evidenceId),
  );
  endpoint(
    "post",
    "/proofs/:id/evidence/:evidenceId/parts/complete",
    "evidence:write",
    (db, p, req) =>
      completeUploadParts(
        db,
        deps.objectStore,
        p.userId,
        req.params.id,
        req.params.evidenceId,
        req.body?.totalBytes,
      ),
  );
  endpoint("post", "/proofs/:id/evidence/discard", "evidence:write", (db, p, req) =>
    discardPendingUpload(
      db,
      deps.clock,
      p.userId,
      req.params.id,
      sha256Hex(
        `${p.tenantId}:${textField(req.body?.uploadIdempotencyKey, "uploadIdempotencyKey")}`,
      ),
    ),
  );
  router.put(
    "/proofs/:id/evidence/:evidenceId/parts/:partNumber",
    route(async (raw, res) => {
      const req = raw as ApiRequest,
        p = req.apiPrincipal!;
      requireScope(p, "evidence:write");
      await requireTenantProof(deps.db, p, req.params.id);
      if (!Buffer.isBuffer(req.body))
        throw new DomainError("INVALID_UPLOAD_PART", "Send binary bytes", 400);
      const part = await storeUploadPart(
        deps.db,
        deps.clock,
        deps.objectStore,
        p.userId,
        req.params.id,
        req.params.evidenceId,
        Number(req.params.partNumber),
        req.body,
      );
      await auditRequest(
        deps.db,
        deps,
        req,
        "PUT /proofs/:id/evidence/:evidenceId/parts/:partNumber",
        200,
      );
      res.json(part);
    }),
  );
  endpoint(
    "post",
    "/proofs/:id/attestations",
    "attestations:write",
    (db, p, req) =>
      commitAttestation(db, deps.clock, p.userId, req.params.id, {
        statement: textField(req.body?.statement, "statement"),
        relatedEvidenceId:
          req.body?.relatedEvidenceId == null
            ? null
            : textField(req.body.relatedEvidenceId, "relatedEvidenceId"),
      }),
    201,
  );
  endpoint("post", "/proofs/:id/finalize", "proofs:finalize", (db, p, req) =>
    finalizeProof(db, deps.clock, p.userId, req.params.id),
  );
  endpoint("get", "/proofs/:id/manifest", "proofs:read", (db, p, req) =>
    getManifest(db, p.userId, req.params.id),
  );
  endpoint("get", "/proofs/:id/review", "proofs:read", (db, p, req) =>
    getEvidenceReview(db, deps.clock, p.userId, req.params.id),
  );
  endpoint(
    "post",
    "/proofs/:id/access-links",
    "proofs:write",
    (db, p, req) =>
      createAccessLink(db, deps.clock, p.userId, req.params.id, {
        scope: req.body?.scope,
        expiresAt:
          req.body?.expiresAt ?? new Date(deps.clock.now().getTime() + 3600000).toISOString(),
        publicWebBaseUrl: webBase,
      }),
    201,
  );
  endpoint("get", "/proofs/:id/events", "events:read", (db, p, req) =>
    listEvents(db, p.tenantId, req.query.after, req.params.id),
  );
  endpoint("get", "/events", "events:read", (db, p, req) =>
    listEvents(db, p.tenantId, req.query.after),
  );
  endpoint("post", "/order-intake", "intake:write", async (_db, _p, req) =>
    previewOrderIntake(req.body),
  );
  endpoint("get", "/webhooks", "webhooks:manage", async (db, p) => ({
    webhooks: await listWebhooks(db, p.tenantId),
  }));
  endpoint(
    "post",
    "/webhooks",
    "webhooks:manage",
    (db, p, req) => createWebhook(db, deps.clock, p.tenantId, req.body, config),
    201,
  );
  endpoint("delete", "/webhooks/:webhookId", "webhooks:manage", (db, p, req) =>
    revokeWebhook(db, deps.clock, p.tenantId, req.params.webhookId),
  );
  endpoint(
    "post",
    "/webhooks/:webhookId/rotate-secret",
    "webhooks:manage",
    (db, p, req) => rotateWebhookSecret(db, p.tenantId, req.params.webhookId, config),
    201,
  );
  endpoint("post", "/webhook-deliveries/:deliveryId/retry", "webhooks:manage", (db, p, req) =>
    retryWebhookDelivery(db, deps.clock, p.tenantId, req.params.deliveryId),
  );
  endpoint("get", "/webhook-deliveries", "webhooks:manage", async (db, p) => ({
    deliveries: (
      await db.query(
        `SELECT d.id,d.event_id AS "eventId",d.webhook_id AS "webhookId",d.state,d.attempts,d.last_status AS "lastStatus",d.next_attempt_at AS "nextAttemptAt"
    FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id WHERE w.tenant_id=$1 ORDER BY d.id DESC LIMIT 100`,
        [p.tenantId],
      )
    ).rows,
  }));
  endpoint("get", "/proofs/:id/lifecycle", "proofs:read", async (db, p, req) => ({
    role: await requireCommerceAccess(db, req.params.id, p.userId),
    proof: await getProofView(db, req.params.id),
    stages: await listCommerceStages(db, req.params.id),
  }));
  endpoint(
    "post",
    "/proofs/:id/lifecycle/receiver",
    "participants:write",
    (db, p, req) =>
      inviteCommerceReceiver(db, deps.clock, p.userId, req.params.id, req.body?.userId),
    201,
  );
  endpoint("post", "/proofs/:id/lifecycle/accept", "participants:write", (db, p, req) =>
    acceptCommerceReceiver(db, deps.clock, p.userId, req.params.id),
  );
  endpoint(
    "post",
    "/proofs/:id/lifecycle/stages",
    "evidence:write",
    (db, p, req) => createCommerceStage(db, deps.clock, p.userId, req.params.id, req.body?.type),
    201,
  );
  endpoint(
    "post",
    "/proofs/:id/lifecycle/stages/:stageId/evidence",
    "evidence:write",
    (db, p, req) =>
      initializeStageEvidence(
        db,
        deps.clock,
        deps.objectStore,
        p.userId,
        req.params.id,
        req.params.stageId,
        {
          contentType: req.body?.contentType,
          idempotencyKey: req.header("Idempotency-Key"),
        },
      ),
    201,
  );
  endpoint(
    "post",
    "/proofs/:id/lifecycle/stages/:stageId/evidence/:evidenceId/commit",
    "evidence:write",
    (db, p, req) =>
      commitStageEvidence(
        db,
        deps.clock,
        deps.objectStore,
        p.userId,
        req.params.id,
        req.params.stageId,
        req.params.evidenceId,
        req.body?.sha256,
      ),
  );
  endpoint(
    "post",
    "/proofs/:id/lifecycle/stages/:stageId/finalize",
    "attestations:write",
    (db, p, req) =>
      finalizeCommerceStage(
        db,
        deps.clock,
        p.userId,
        req.params.id,
        req.params.stageId,
        req.body?.statement,
      ),
  );
  endpoint(
    "post",
    "/proofs/:id/lifecycle/stages/:stageId/evidence/:evidenceId/discard",
    "evidence:write",
    (db, p, req) =>
      discardStageEvidence(
        db,
        deps.clock,
        p.userId,
        req.params.id,
        req.params.stageId,
        req.params.evidenceId,
      ),
  );
  endpoint("get", "/proofs/:id/retention", "proofs:read", (db, p, req) =>
    getRetentionControls(db, deps.clock, p.userId, req.params.id),
  );
  endpoint(
    "post",
    "/proofs/:id/retention/holds",
    "proofs:write",
    (db, p, req) => createRetentionHold(db, deps.clock, p.userId, req.params.id, req.body?.reason),
    201,
  );
  endpoint("delete", "/proofs/:id/retention/holds/:holdId", "proofs:write", (db, p, req) =>
    releaseRetentionHold(db, deps.clock, p.userId, req.params.id, req.params.holdId),
  );
  endpoint(
    "post",
    "/proofs/:id/retention/deletion-requests",
    "proofs:write",
    (db, p, req) => requestProofDeletion(db, deps.clock, p.userId, req.params.id, req.body?.reason),
    201,
  );
  router.get(
    "/proofs/:id/package",
    route(async (raw, res) => {
      const req = raw as ApiRequest,
        p = req.apiPrincipal!;
      requireScope(p, "proofs:read");
      await requireTenantProof(deps.db, p, req.params.id);
      const bytes = await exportEvidencePackage(
        deps.db,
        deps.clock,
        deps.objectStore,
        p.userId,
        req.params.id,
      );
      await auditRequest(deps.db, deps, req, "GET /proofs/:id/package", 200);
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.pkpr"`);
      res.type("application/zip").send(bytes);
    }),
  );
  router.get(
    "/proofs/:id/evidence/:evidenceId",
    route(async (raw, res) => {
      const req = raw as ApiRequest,
        p = req.apiPrincipal!;
      requireScope(p, "proofs:read");
      await requireTenantProof(deps.db, p, req.params.id);
      const result = await readCommittedEvidence(
        deps.db,
        deps.objectStore,
        p.userId,
        req.params.id,
        req.params.evidenceId,
      );
      await auditRequest(deps.db, deps, req, "GET /proofs/:id/evidence/:evidenceId", 200);
      res.type(result.contentType).send(result.body);
    }),
  );
  router.use((_req, _res, next) => next(new DomainError("NOT_FOUND", "Unknown v1 endpoint", 404)));
  router.use((error: unknown, raw: Request, res: Response, _next: NextFunction) => {
    const req = raw as ApiRequest;
    const domain = error instanceof DomainError ? error : null;
    const status = domain?.httpStatus ?? (errorCodeFromSql(error) ? 409 : 500);
    if (status === 429) res.setHeader("Retry-After", "60");
    void auditRequest(deps.db, deps, req, `${req.method} ${req.route?.path ?? "/unknown"}`, status)
      .catch(() => undefined)
      .finally(() => {
        res.status(status).json({
          error: {
            code: domain?.code ?? errorCodeFromSql(error) ?? "INTERNAL",
            message: domain?.message ?? "Request could not be completed",
            requestId: req.apiRequestId,
          },
        });
      });
  });
  return router;
}
async function auditRequest(
  db: Database,
  deps: AppDependencies,
  req: ApiRequest,
  operation: string,
  status: number,
) {
  // Unauthenticated probes carry no user/tenant identifiers and need no durable
  // row. Reverse-proxy access logs handle those without enabling DB amplification.
  if (!req.apiPrincipal) return;
  await db.query(
    `INSERT INTO api_request_audit(id,tenant_id,key_id,actor_user_id,operation,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      req.apiRequestId,
      req.apiPrincipal.tenantId,
      req.apiPrincipal.keyId,
      req.apiPrincipal.userId,
      operation,
      status,
      deps.clock.now().toISOString(),
    ],
  );
}
export function createTenantManagementRouter(deps: AppDependencies) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const user = (req: Request) => {
    if (!req.packproofUserId)
      throw new DomainError("UNAUTHENTICATED", "Sign in to manage API access", 401);
    return req.packproofUserId;
  };
  router.get(
    "/",
    route(async (req, res) => {
      res.json({
        tenants: (
          await deps.db.query(
            `SELECT id,name,environment,created_at AS "createdAt" FROM api_tenants WHERE owner_user_id=$1 ORDER BY created_at,id`,
            [user(req)],
          )
        ).rows,
        availableScopes: API_SCOPES,
      });
    }),
  );
  router.post(
    "/",
    route(async (req, res) => {
      res.status(201).json(await createTenant(deps.db, deps.clock, user(req), req.body));
    }),
  );
  router.get(
    "/:tenantId/keys",
    route(async (req, res) => {
      await requireTenantOwner(deps.db, user(req), req.params.tenantId);
      res.json({
        keys: (
          await deps.db.query(
            `SELECT id,name,prefix,scopes,created_at AS "createdAt",revoked_at AS "revokedAt" FROM api_keys WHERE tenant_id=$1 ORDER BY created_at,id`,
            [req.params.tenantId],
          )
        ).rows,
      });
    }),
  );
  router.post(
    "/:tenantId/keys",
    route(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res
        .status(201)
        .json(await issueApiKey(deps.db, deps.clock, user(req), req.params.tenantId, req.body));
    }),
  );
  router.delete(
    "/:tenantId/keys/:keyId",
    route(async (req, res) => {
      await revokeApiKey(deps.db, deps.clock, user(req), req.params.tenantId, req.params.keyId);
      res.status(204).end();
    }),
  );
  router.post(
    "/:tenantId/keys/:keyId/rotate",
    route(async (req, res) => {
      const result = await deps.db.transaction(async (tx) => {
        await requireTenantOwner(tx, user(req), req.params.tenantId);
        const old = await tx.query<{ name: string; scopes: ApiScope[] }>(
          "SELECT name,scopes FROM api_keys WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL FOR UPDATE",
          [req.params.keyId, req.params.tenantId],
        );
        if (!old.rows[0]) throw new DomainError("KEY_NOT_FOUND", "Active key not found", 404);
        const key = await issueApiKey(tx, deps.clock, user(req), req.params.tenantId, old.rows[0]);
        await revokeApiKey(tx, deps.clock, user(req), req.params.tenantId, req.params.keyId);
        return key;
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(result);
    }),
  );
  return router;
}
