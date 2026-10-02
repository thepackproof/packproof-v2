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

export function researchEnabled(): boolean { return process.env.EXPO_PUBLIC_PACKPROOF_RND === 'true'; }
