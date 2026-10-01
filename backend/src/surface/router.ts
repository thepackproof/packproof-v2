import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppDependencies } from '../app.js';
import { access, fail, initializeMedia, commitMedia, createIntent, recordCommand, surfaceSummary, surfaceExport, recordView, scopedRecord, source } from './service.js';
import { appendAudit } from '../domain/audit.js';
import { sha256Hex } from '../hash.js';
const route = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  void fn(req, res).catch(next);
};
function actor(req: Request) {
  if (!req.packproofUserId) fail('UNAUTHENTICATED', 'Sign in to use experimental surface evidence', 401);
  return req.packproofUserId;
}
export function surfaceRouter(deps: AppDependencies) {
  const router = express.Router({
    mergeParams: true
  });
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/', route(async (req, res) => {
    const user = actor(req);
    const summary = await surfaceSummary(deps, user, req.params.id);
    await appendAudit(deps.db, {
      proofId: req.params.id,
      actorUserId: user,
      eventType: 'SURFACE_SUMMARY_READ',
      eventData: {},
      at: deps.clock.now()
    });
    res.json(summary);
  }));
  router.post('/media', route(async (req, res) => {
    res.status(201).json(await initializeMedia(deps, actor(req), req.params.id, req.body, String(req.header('idempotency-key') ?? '')));
  }));
  router.put('/media/:sourceId', express.raw({
    type: ['image/jpeg', 'image/png'],
    limit: '8mb'
  }), route(async (req, res) => {
    res.json(await commitMedia(deps, actor(req), req.params.id, req.params.sourceId, req.body));
  }));
  router.get('/media/:sourceId', route(async (req, res) => {
    const user = actor(req);
    await access(deps.db, req.params.id, user);
    const s = await source(deps.db, req.params.id, req.params.sourceId);
    const bytes = await deps.objectStore.get(s.objectKey, {
      versionId: s.objectVersionId
    });
    if (!bytes) fail('SURFACE_SOURCE_EXPIRED', 'Original source is no longer retained', 410);
    if (bytes.body.length !== s.byteSize || sha256Hex(bytes.body) !== s.sha256) fail('SURFACE_SOURCE_INTEGRITY', 'Retained source does not match commitment', 409);
    await appendAudit(deps.db, {
      proofId: req.params.id,
      actorUserId: user,
      eventType: 'SURFACE_SOURCE_READ',
      eventData: {
        sourceId: s.sourceId
      },
      at: deps.clock.now()
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${s.sourceId}.${s.contentType === 'image/png' ? 'png' : 'jpg'}"`);
    res.type(s.contentType).send(bytes.body);
  }));
  router.post('/intents', route(async (req, res) => {
    res.status(201).json(await createIntent(deps, actor(req), req.params.id, req.body));
  }));
  for (const [path, kind] of [['enrollments', 'enrollment'], ['observations', 'observation'], ['comparisons', 'comparison']] as const) router.post(`/${path}`, route(async (req, res) => {
    res.status(202).json(await recordCommand(deps, actor(req), req.params.id, kind, req.body, String(req.header('idempotency-key') ?? '')));
  }));
  router.get('/comparisons/:comparisonId', route(async (req, res) => {
    await access(deps.db, req.params.id, actor(req));
    const record = await recordView(deps.db, await scopedRecord(deps.db, req.params.id, req.params.comparisonId, 'comparison'));
    await appendAudit(deps.db, {
      proofId: req.params.id,
      actorUserId: actor(req),
      eventType: 'SURFACE_COMPARISON_READ',
      eventData: {
        comparisonId: record.id
      },
      at: deps.clock.now()
    });
    res.json(record);
  }));
  router.get('/export', route(async (req, res) => {
    const data = await surfaceExport(deps, actor(req), req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-surface-research.json"`);
    res.json(data);
  }));
  router.use((error: unknown, req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const user = actor(req);
        await access(deps.db, req.params.id, user);
        await appendAudit(deps.db, {
          proofId: req.params.id,
          actorUserId: user,
          eventType: 'SURFACE_REQUEST_REJECTED',
          eventData: {
            code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SURFACE_REQUEST_ERROR',
            method: req.method
          },
          at: deps.clock.now()
        });
      } catch {}
      next(error);
    })();
  });
  return router;
}
