/** The research app never falls back to the production/staging service or cached endpoints. */
export function assertResearchEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '10.0.2.2', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PackProof Research requires a loopback laboratory API. Production endpoints are disabled.');
  }
  return url.origin;
}

export function researchProductionEnabled(): boolean { return process.env.EXPO_PUBLIC_PACKPROOF_RND_PRODUCTION === 'true'; }
export function researchEnabled(): boolean { return process.env.EXPO_PUBLIC_PACKPROOF_RND === 'true' || researchProductionEnabled(); }

/** Production receipts use only the compiled authenticated origin, never cached lab endpoints. */
export function assertProductionReceiptEndpoint(value: string, configured: string): string {
  const url = new URL(value), expected = new URL(configured);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.includes(':') || /^(?:0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== 'https:' || privateHost || /^\d+(?:\.\d+){3}$/.test(host) || (url.port && url.port !== '443') || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      expected.href !== url.href) throw new Error('Capture receipts require the configured public HTTPS API.');
  return url.origin;
}
export function assertResearchApiEndpoint(value: string): string {
  if (researchProductionEnabled()) {
    if (process.env.EXPO_PUBLIC_PACKPROOF_RND === 'true') throw new Error('Laboratory and production research modes cannot be combined.');
    return assertProductionReceiptEndpoint(value, process.env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL ?? '');
  }
  return assertResearchEndpoint(value);
}
