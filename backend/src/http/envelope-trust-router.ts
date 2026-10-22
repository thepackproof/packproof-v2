import { Router } from 'express';
import { DomainError } from '../domain/errors.js';
import type { EnvelopeTrustPublication } from '../integrity/envelope-publication.js';

export function envelopeTrustRouter(publication?: EnvelopeTrustPublication | null) {
  const router = Router();
  router.get('/.well-known/packproof-envelope-trust.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!publication) throw new DomainError('ENVELOPE_TRUST_DISABLED', 'Envelope key-history publication is not enabled.', 404);
    res.json(publication.snapshot());
  });
  return router;
}
