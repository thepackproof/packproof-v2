/** Store only an allowlisted authorization locator, never enrollment redemption secrets. */
export const CONNECT_APPROVAL_RETURN_KEY = 'packproof.connect.approval-return.v1';

export function connectApprovalReturnPath(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.length > 2048) return null;
  try {
    const url = new URL(href, 'https://packproof.local');
    if (url.pathname !== '/app/records/connect/approve' || url.hash) return null;
    // A return is one exact locator. Reject repeated keys rather than letting
    // different layers choose different occurrences after authentication.
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return null;
    const enrollment = url.searchParams.get('enrollmentId');
    const installation = url.searchParams.get('installationId');
    const validId = (value: string | null) => !!value && /^[A-Za-z0-9_-]{1,160}$/.test(value);
    if (enrollment !== null && !validId(enrollment) || installation !== null && !validId(installation)) return null;
    if (validId(enrollment) === validId(installation)) return null;
    const subscription = url.searchParams.get('subscriptionId');
    const configurationRevision = url.searchParams.get('configurationRevision');
    const initialBatch = url.searchParams.get('initialBatchId');
    const backfill = url.searchParams.get('backfillJobId');
    const manifest = url.searchParams.get('manifestSha256');
    const importId = url.searchParams.get('importId');
    if (importId !== null && (!installation || !validId(importId))) return null;
    if (subscription !== null) {
      if (!installation || enrollment || !validId(subscription) || importId !== null || url.searchParams.has('action')) return null;
      if (configurationRevision !== null && (!/^[1-9][0-9]{0,9}$/.test(configurationRevision) || Number(configurationRevision) > 2147483647)) return null;
      if (initialBatch !== null && !validId(initialBatch)) return null;
      if (backfill !== null || manifest !== null) {
        if (!validId(backfill) || !manifest || !/^[a-f0-9]{64}$/.test(manifest) || configurationRevision === null || initialBatch !== null) return null;
      }
    } else if (configurationRevision !== null || initialBatch !== null || backfill !== null || manifest !== null) return null;
    if (enrollment && (importId !== null || url.searchParams.has('action'))) return null;
    const kept = new URLSearchParams();
    if (enrollment) kept.set('enrollmentId', enrollment);
    if (installation) kept.set('installationId', installation);
    const organization = url.searchParams.get('organizationId');
    if (organization !== null && !validId(organization)) return null;
    if (validId(organization)) kept.set('organizationId', organization!);
    const environment = url.searchParams.get('environment');
    if (environment !== null && environment !== 'sandbox' && environment !== 'live') return null;
    if (environment === 'sandbox' || environment === 'live') kept.set('environment', environment);
    if (validId(importId) && installation) kept.set('importId', importId!);
    if (subscription) kept.set('subscriptionId', subscription);
    if (configurationRevision) kept.set('configurationRevision', configurationRevision);
    if (initialBatch) kept.set('initialBatchId', initialBatch);
    if (backfill) kept.set('backfillJobId', backfill);
    if (manifest) kept.set('manifestSha256', manifest);
    if (installation && url.searchParams.get('action') === 'resume') kept.set('action', 'resume');
    return '/app/records/connect/approve?' + kept.toString();
  } catch { return null; }
}

type ApprovalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function rememberConnectApprovalReturn(path: string, storage: ApprovalStorage): void {
  const safe = connectApprovalReturnPath(path);
  if (safe) storage.setItem(CONNECT_APPROVAL_RETURN_KEY, safe);
}
export function consumeConnectApprovalReturn(storage: ApprovalStorage): string | null {
  const candidate = storage.getItem(CONNECT_APPROVAL_RETURN_KEY);
  storage.removeItem(CONNECT_APPROVAL_RETURN_KEY);
  return candidate ? connectApprovalReturnPath(candidate) : null;
}
