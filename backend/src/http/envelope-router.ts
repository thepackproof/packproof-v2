import { Router, type Request, type Response, type NextFunction } from 'express';
import { pipeline } from 'node:stream/promises';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { requestProofEnvelope, getProofEnvelope, exportProofEnvelope } from '../integrity/envelope-access.js';
const route = (fn: (q: Request, s: Response) => Promise<void>) => (q: Request, s: Response, n: NextFunction) => { void fn(q, s).catch(n); };
export function envelopeRouter(deps: AppDependencies) {
  const router = Router({ mergeParams: true });
  const actor = (q: Request) => { if (!q.packproofUserId) throw new DomainError('UNAUTHENTICATED', 'Sign in to access this record.', 401); return q.packproofUserId; };
  router.use((_q, s, n) => { s.setHeader('Cache-Control', 'private, no-store'); s.setHeader('X-Content-Type-Options', 'nosniff'); n(); });
  router.post('/', route(async (q, s) => { s.status(202).json(await requestProofEnvelope(deps.db, deps.clock, actor(q), q.params.id, q.body, deps.envelopes)); }));
  router.get('/:operationId', route(async (q, s) => { s.json(await getProofEnvelope(deps.db, actor(q), q.params.id, q.params.operationId, deps.envelopes)); }));
  router.get('/:operationId/package', route(async (q, s) => {
    const stream = await exportProofEnvelope(deps.db, actor(q), q.params.id, q.params.operationId, deps.envelopes);
    s.setHeader('Content-Disposition', 'attachment; filename="packproof-integrity.pkpr"'); s.type('application/zip');
    await pipeline(stream, s);
  }));
  return router;
}
