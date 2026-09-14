import express, { type Request, type Response, type NextFunction } from 'express';
import { pipeline } from 'node:stream/promises';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { createLifecycleSnapshot, getLifecycleSnapshot } from '../domain/lifecycle-snapshots.js';
import { issueCaptureCompletionReceipt, readCaptureCompletionReceipt } from '../capture/completion-receipt.js';
import { exportEvidencePackageStream } from '../domain/evidence-review.js';
import { requireFuturePlatform } from '../platform/future-config.js';

const route = (fn: (r: Request, s: Response) => Promise<void>) =>
  (r: Request, s: Response, n: NextFunction) => { void fn(r, s).catch(n); };

export function futurePlatformRouter(deps: AppDependencies) {
  const router = express.Router();
  const actor = (req: Request, write = false) => {
    if (!req.packproofUserId) throw new DomainError('UNAUTHENTICATED', 'Sign in to access this Proof', 401);
    requireFuturePlatform(deps.futurePlatform, { userId: req.packproofUserId }, write);
    return req.packproofUserId;
  };
  router.use(['/proofs/:id/lifecycle-snapshots', '/capture-sessions/:captureId/completion-receipt'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('PackProof-Platform-Profile', 'future.v1');
    next();
  });
  router.post('/proofs/:id/lifecycle-snapshots', route(async (req, res) => {
    const user = actor(req, true);
    if (Object.keys(req.body ?? {}).some(k => k !== 'purpose'))
      throw new DomainError('INVALID_REQUEST', 'Only the snapshot purpose may be supplied', 400);
    const snapshot = await createLifecycleSnapshot(deps.db, deps.clock, deps.manifestSigning?.signer, user, req.params.id,
      { operationId: req.header('Idempotency-Key') ?? '', purpose: req.body?.purpose });
    res.status(201).json(snapshot);
  }));
  router.get('/proofs/:id/lifecycle-snapshots/:snapshotId', route(async (req, res) => {
    res.json(await getLifecycleSnapshot(deps.db, actor(req), req.params.id, req.params.snapshotId));
  }));
  router.get('/proofs/:id/lifecycle-snapshots/:snapshotId/download', route(async (req, res) => {
    const archive = await exportEvidencePackageStream(deps.db, deps.clock, deps.objectStore, actor(req), req.params.id,
      { lifecycleSnapshotId: req.params.snapshotId });
    res.setHeader('Content-Disposition', 'attachment; filename="packproof-lifecycle.pkpr"');
    res.type('application/zip');
    await pipeline(archive, res);
  }));
  router.post('/capture-sessions/:captureId/completion-receipt', route(async (req, res) => {
    const user = actor(req, true);
    if (Object.keys(req.body ?? {}).length)
      throw new DomainError('INVALID_REQUEST', 'Completion is determined from the committed recording', 400);
    res.status(201).json(await issueCaptureCompletionReceipt(deps.db, deps.clock, user, req.params.captureId, deps.manifestSigning?.signer));
  }));
  router.get('/capture-sessions/:captureId/completion-receipt', route(async (req, res) => {
    res.json(await readCaptureCompletionReceipt(deps.db, actor(req), req.params.captureId));
  }));
  return router;
}
