/** Store only an allowlisted authorization locator, never enrollment redemption secrets. */
export const CONNECT_APPROVAL_RETURN_KEY = 'packproof.connect.approval-return.v1';

export function connectApprovalReturnPath(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.length > 2048) return null;
  try {
    const url = new URL(href, 'https://packproof.local');
    if (url.pathname !== '/app/records/connect/approve' || url.hash) return null;
    const enrollment = url.searchParams.get('enrollmentId');
    const installation = url.searchParams.get('installationId');
    const validId = (value: string | null) => !!value && /^[A-Za-z0-9_-]{1,160}$/.test(value);
    if (validId(enrollment) === validId(installation)) return null;
    const kept = new URLSearchParams();
    if (enrollment) kept.set('enrollmentId', enrollment);
    if (installation) kept.set('installationId', installation);
    const organization = url.searchParams.get('organizationId');
    if (validId(organization)) kept.set('organizationId', organization!);
    const environment = url.searchParams.get('environment');
    if (environment === 'sandbox' || environment === 'live') kept.set('environment', environment);
    const importId = url.searchParams.get('importId');
    if (validId(importId) && installation) kept.set('importId', importId!);
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
