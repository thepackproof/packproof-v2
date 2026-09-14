import type { UploadTarget } from '../v2-api';

/** Fresh uploads stream the original through the OS to the server-issued target.
 * Production keeps its bounded admission gateway; existing part journals retain resumable transport. */
export function useDirectUpload(target: UploadTarget, apiBaseUrl: string): boolean {
  if (target.received || target.method !== 'PUT') return false;
  try {
    const api = new URL(apiBaseUrl);
    const url = new URL(target.url, api.toString());
    if (url.protocol !== 'https:') return false;
    if (url.origin === api.origin) return /^\/upload\/admission_[A-Za-z0-9_-]{43}$/.test(url.pathname);
    return /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(url.hostname);
  } catch { return false; }
}
