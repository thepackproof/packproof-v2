import type { UploadTarget } from '../v2-api';

function isS3Hostname(hostname: string): boolean {
  const suffix = '.amazonaws.com';
  if (!hostname.endsWith(suffix)) return false;
  const labels = hostname.slice(0, -suffix.length).split('.');
  // Walk from the AWS suffix toward the service label. Each label is inspected
  // once, including malformed runs of hyphens that defeated the old regexp.
  for (let index = labels.length - 1; index >= 0; index--) {
    const label = labels[index];
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label === 's3' || (label.startsWith('s3-') && label.length > 3)) return true;
  }
  return false;
}

/** Fresh uploads stream the original through the OS to the server-issued target.
 * Production keeps its bounded admission gateway; existing part journals retain resumable transport. */
export function useDirectUpload(target: UploadTarget, apiBaseUrl: string): boolean {
  if (target.received || target.method !== 'PUT') return false;
  try {
    const api = new URL(apiBaseUrl);
    const url = new URL(target.url, api.toString());
    if (url.protocol !== 'https:') return false;
    if (url.origin === api.origin) return /^\/upload\/admission_[A-Za-z0-9_-]{43}$/.test(url.pathname);
    return isS3Hostname(url.hostname);
  } catch { return false; }
}
