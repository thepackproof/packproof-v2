import express, { type Request, type Response, type NextFunction } from "express";
import type { AppDependencies } from "../app.js";
import { DomainError } from "../domain/errors.js";
import {
  createSignatureAnchor, createSignatureSnapshot, getSignatureSnapshot, askSignatureProof,
  buildSignatureCase, getSignatureCase, approveSignatureCase, exportSignatureCase,
  appendSignatureComparison, listSignatureComparisons, getItemHistory, setItemHistoryConsent,
  linkItemHistory, appendItemHistoryEvent,
  signatureCapabilities, recordSignatureUsage, getSignatureUsage, type SignatureFeature,
  getSignatureOutboundView,
  previewItemHistoryShare, createItemHistoryShare, getItemHistoryShare, revokeItemHistoryShare,
} from "../domain/signature.js";

const route = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

/** Mount behind human authentication at /proofs/:id/signature. Guest grants never enter this router. */
export function signatureRouter(deps: AppDependencies) {
  const router = express.Router({ mergeParams: true });
  const user = (req: Request) => {
    if (!req.packproofUserId) throw new DomainError("UNAUTHENTICATED", "Sign in to inspect this Proof", 401);
    return req.packproofUserId;
  };
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  router.use((req, res, next) => {
    const start = performance.now();
    const feature: SignatureFeature = req.path.startsWith("/ask") ? "ask" : req.path.startsWith("/cases") ? "cases" : req.path.startsWith("/comparisons") ? "compare" : req.path.startsWith("/history") ? "history" : "replay";
    res.once("finish", () => {
      if (req.packproofUserId && req.params.id) void recordSignatureUsage(deps.db, deps.clock, req.packproofUserId,
        req.params.id, feature, res.statusCode >= 400, performance.now() - start, Number(res.getHeader("content-length") ?? 0)).catch(() => { /* A metrics outage must not affect original evidence or disclose request text. */ });
    });
    next();
  });
  router.get("/", route(async (req, res) => {
    const actor = user(req), proofId = req.params.id;
    const capabilities = signatureCapabilities();
    if (req.query.snapshotId != null && typeof req.query.snapshotId !== "string") throw new DomainError("INVALID_SIGNATURE_INPUT", "Choose one snapshot ID", 400);
    const snapshot = req.query.snapshotId ? await getSignatureSnapshot(deps.db, actor, proofId, req.query.snapshotId as string)
      : await createSignatureSnapshot(deps.db, deps.clock, actor, proofId);
    if (snapshot.data.audience === "RECEIVER") { capabilities.compare = false; capabilities.history = false; }
    res.json({ capabilities, snapshot,
      comparisons: capabilities.compare ? await listSignatureComparisons(deps.db, actor, proofId) : [],
      history: capabilities.history ? await getItemHistory(deps.db, actor, proofId) : { optedIn: false, entries: [], partial: true, limitations: ["Item history is temporarily disabled."] } });
  }));
  router.get("/snapshots/:snapshotId", route(async (req, res) => {
    res.json(await getSignatureSnapshot(deps.db, user(req), req.params.id, req.params.snapshotId));
  }));
  router.post("/outbound-view", route(async (req, res) => {
    res.json(await getSignatureOutboundView(deps.db, deps.clock, user(req), req.params.id, req.body?.token));
  }));
  router.post("/anchors", route(async (req, res) => {
    res.status(201).json(await createSignatureAnchor(deps.db, deps.clock, user(req), req.params.id,
      { ...req.body, idempotencyKey: req.header("Idempotency-Key") ?? req.body?.idempotencyKey }));
  }));
  router.post("/ask", route(async (req, res) => {
    res.json(await askSignatureProof(deps.db, user(req), req.params.id, req.body ?? {}));
  }));
  router.post("/cases", route(async (req, res) => {
    res.status(201).json(await buildSignatureCase(deps.db, deps.clock, user(req), req.params.id, req.body ?? {}));
  }));
  router.get("/cases/:caseId", route(async (req, res) => {
    res.json(await getSignatureCase(deps.db, user(req), req.params.id, req.params.caseId));
  }));
  router.post("/cases/:caseId/approve", route(async (req, res) => {
    res.json(await approveSignatureCase(deps.db, deps.clock, user(req), req.params.id, req.params.caseId, req.body?.previewSha256));
  }));
  router.get("/cases/:caseId/export", route(async (req, res) => {
    const result = await exportSignatureCase(deps.db, deps.clock, user(req), req.params.id, req.params.caseId);
    res.setHeader("Content-Disposition", `attachment; filename="packproof-case-${req.params.caseId.replace(/[^A-Za-z0-9_-]/g, "")}.json"`);
    res.setHeader("X-Artifact-Sha256", result.artifactSha256);
    res.type("application/json").send(result.bytes);
  }));
  router.get("/cases/:caseId/export.html", route(async (req, res) => {
    const result = await exportSignatureCase(deps.db, deps.clock, user(req), req.params.id, req.params.caseId, "html", deps.corsOrigins?.find(origin => /^https?:\/\//.test(origin)));
    res.setHeader("Content-Disposition", `attachment; filename="packproof-case-${req.params.caseId.replace(/[^A-Za-z0-9_-]/g, "")}.html"`);
    res.setHeader("X-Artifact-Sha256", result.artifactSha256);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.type("text/html").send(result.bytes);
  }));
  router.get("/usage", route(async (req, res) => { res.json(await getSignatureUsage(deps.db, user(req), req.params.id)); }));
  router.post("/comparisons", route(async (req, res) => {
    res.status(201).json(await appendSignatureComparison(deps.db, deps.clock, user(req), req.params.id, req.body ?? {}));
  }));
  router.post("/history/consent", route(async (req, res) => {
    res.json(await setItemHistoryConsent(deps.db, deps.clock, user(req), req.params.id, req.body?.optIn));
  }));
  router.post("/history", route(async (req, res) => {
    res.status(201).json(await linkItemHistory(deps.db, deps.clock, user(req), req.params.id, req.body ?? {}));
  }));
  router.post("/history/:linkId/events", route(async (req, res) => {
    res.status(201).json(await appendItemHistoryEvent(deps.db, deps.clock, user(req), req.params.id, req.params.linkId, req.body ?? {}));
  }));
  router.post("/history/preview", route(async (req, res) => {
    res.json(await previewItemHistoryShare(deps.db, user(req), req.params.id, req.body ?? {}));
  }));
  router.post("/history/share", route(async (req, res) => {
    res.status(201).json(await createItemHistoryShare(deps.db, deps.clock, user(req), req.params.id, req.body ?? {}));
  }));
  router.get("/history/shares/:shareId", route(async (req, res) => {
    res.json(await getItemHistoryShare(deps.db, user(req), req.params.id, req.params.shareId));
  }));
  router.post("/history/shares/:shareId/revoke", route(async (req, res) => {
    res.json(await revokeItemHistoryShare(deps.db, deps.clock, user(req), req.params.id, req.params.shareId));
  }));
  return router;
}
