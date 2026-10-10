import { describe, expect, it } from 'vitest';
import express from 'express';
import { configureTrustedProxy } from '../src/http/boundary.js';

function trustedProxy(subnet: string): (address: string, hop: number) => boolean {
  const app = express();
  configureTrustedProxy(app, { PACKPROOF_TRUSTED_PROXIES: subnet });
  return app.get('trust proxy fn');
}

describe('trusted-proxy dependency security regression', () => {
  it('does not trust public IPv4 through short mapped or generic IPv6 subnets', () => {
    // GHSA-jqcg-44mw-7w3h: the old dependency matched every IPv4 address
    // against these zero-leading-bit IPv6 ranges, trusting caller-supplied XFF.
    for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
      const trust = trustedProxy(subnet);
      expect(trust('203.0.113.9', 0), subnet).toBe(false);
      expect(trust('198.51.100.7', 0), subnet).toBe(false);
    }
  });

  it('keeps a correctly expressed mapped subnet limited to its IPv4 range', () => {
    const trust = trustedProxy('::ffff:10.0.0.0/104');
    expect(trust('10.4.5.6', 0)).toBe(true);
    expect(trust('::ffff:10.4.5.6', 0)).toBe(true);
    expect(trust('203.0.113.9', 0)).toBe(false);
    expect(trust('::ffff:203.0.113.9', 0)).toBe(false);
  });

  it('preserves explicit IPv4 and IPv6 trust boundaries', () => {
    const ipv4 = trustedProxy('10.0.0.0/8');
    expect(ipv4('10.4.5.6', 0)).toBe(true);
    expect(ipv4('203.0.113.9', 0)).toBe(false);
    const ipv6 = trustedProxy('2001:db8:1234::/48');
    expect(ipv6('2001:db8:1234::1', 0)).toBe(true);
    expect(ipv6('2001:db8:4321::1', 0)).toBe(false);
    expect(ipv6('203.0.113.9', 0)).toBe(false);
  });
});
