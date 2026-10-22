import { describe, expect, it } from 'vitest';
import { assertEnvelopeRequestBudget } from '../src/integrity/envelope-access.js';
import type { EnvelopeRequest } from '../src/integrity/envelope-jobs.js';

const request = (sizes: number[]) => ({
  manifests: [{ canonicalJson: '\u00e9' }],
  originals: sizes.map(byteSize => ({ byteSize })),
}) as Pick<EnvelopeRequest, 'manifests' | 'originals'>;

describe('envelope pre-I/O byte budget', () => {
  it('reserves metadata space and counts exact UTF-8 manifest bytes', () => {
    expect(() => assertEnvelopeRequestBudget(request([200 * 1024 * 1024 - 2]))).not.toThrow();
    expect(() => assertEnvelopeRequestBudget(request([200 * 1024 * 1024 - 1]))).toThrow('supported integrity package size');
  });
  it('rejects aggregate oversize and invalid lengths without allocating media', () => {
    for (const sizes of [[150 * 1024 * 1024, 100 * 1024 * 1024], [Number.MAX_SAFE_INTEGER], [NaN], [-1], [0.5]]) {
      expect(() => assertEnvelopeRequestBudget(request(sizes))).toThrow();
    }
  });
});
