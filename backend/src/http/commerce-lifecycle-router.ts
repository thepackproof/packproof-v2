import express, { type Request, type Response, type NextFunction } from "express";
import type { AppDependencies } from "../app.js";
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
import { DomainError } from "../domain/errors.js";
import { getProofView } from "../domain/proofs.js";
import { sha256Hex } from "../hash.js";
const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
export function commerceLifecycleRouter(deps: AppDependencies) {
  const router = express.Router({ mergeParams: true });
  const user = (req: Request) => {
    if (!req.packproofUserId)
      throw new DomainError("UNAUTHENTICATED", "Sign in to view receipt evidence", 401);
    return req.packproofUserId;
  };
  router.get(
    "/",
    route(async (req, res) => {
      const role = await requireCommerceAccess(deps.db, req.params.id, user(req));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        proof: await getProofView(deps.db, req.params.id),
        role,
        stages: await listCommerceStages(deps.db, req.params.id),
      });
    }),
  );
  router.post(
    "/receiver",
    route(async (req, res) => {
      res
        .status(201)
        .json(
          await inviteCommerceReceiver(
            deps.db,
            deps.clock,
            user(req),
            req.params.id,
            req.body?.userId,
          ),
        );
    }),
  );
  router.post(
    "/accept",
    route(async (req, res) => {
      res.json(await acceptCommerceReceiver(deps.db, deps.clock, user(req), req.params.id));
    }),
  );
  router.post(
    "/stages",
    route(async (req, res) => {
      res
        .status(201)
        .json(
          await createCommerceStage(deps.db, deps.clock, user(req), req.params.id, req.body?.type),
        );
    }),
  );
  router.post(
    "/stages/:stageId/evidence",
    route(async (req, res) => {
      res.status(201).json(
        await initializeStageEvidence(
          deps.db,
          deps.clock,
          deps.objectStore,
          user(req),
          req.params.id,
          req.params.stageId,
          {
            contentType: req.body?.contentType,
            idempotencyKey: req.header("Idempotency-Key") ?? req.body?.idempotencyKey,
          },
        ),
      );
    }),
  );
  router.post(
    "/stages/:stageId/evidence/:evidenceId/commit",
    route(async (req, res) => {
      res.json(
        await commitStageEvidence(
          deps.db,
          deps.clock,
          deps.objectStore,
          user(req),
          req.params.id,
          req.params.stageId,
          req.params.evidenceId,
          req.body?.sha256,
        ),
      );
    }),
  );
  router.post(
    "/stages/:stageId/finalize",
    route(async (req, res) => {
      res.json(
        await finalizeCommerceStage(
          deps.db,
          deps.clock,
          user(req),
          req.params.id,
          req.params.stageId,
          req.body?.statement,
        ),
      );
    }),
  );
  router.get(
    "/stages/:stageId/evidence/:evidenceId",
    route(async (req, res) => {
      await requireCommerceAccess(deps.db, req.params.id, user(req));
      const media = (
        await deps.db.query<{
          object_key: string;
          sha256: string;
          content_type: string;
        }>(
          `SELECT e.* FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id
      WHERE s.proof_id=$1 AND s.id=$2 AND e.id=$3 AND e.committed_at IS NOT NULL`,
          [req.params.id, req.params.stageId, req.params.evidenceId],
        )
      ).rows[0];
      const object = media ? await deps.objectStore.get(media.object_key) : null;
      if (!object || sha256Hex(object.body) !== media.sha256)
        throw new DomainError("EVIDENCE_NOT_FOUND", "Stage recording unavailable", 404);
      res.setHeader("Cache-Control", "private, no-store");
      res.type(media.content_type).send(object.body);
    }),
  );
  router.post(
    "/stages/:stageId/evidence/:evidenceId/discard",
    route(async (req, res) => {
      res.json(
        await discardStageEvidence(
          deps.db,
          deps.clock,
          user(req),
          req.params.id,
          req.params.stageId,
          req.params.evidenceId,
        ),
      );
    }),
  );
  return router;
}
