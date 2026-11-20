export type HumanDashboardIdentity = {
  apiBaseUrl: string; userId: string; username: string | null; displayName: string | null;
  token(): Promise<string>;
};

export function allowedDashboardRequest(url: string, method: string, apiBase: string, scope: {
  organizationId:string; environment:string; locationId?:string|null
}) {
  const target = new URL(url), base = new URL(apiBase);
  if (target.origin !== base.origin || target.username || target.password) return false;
  const prefix = base.pathname.replace(/\/$/,'') + '/me/records/';
  if (!target.pathname.startsWith(prefix)) return false;
  const path = target.pathname.slice(prefix.length);
  if (target.searchParams.getAll('organizationId').length !== 1 || target.searchParams.get('organizationId') !== scope.organizationId ||
      target.searchParams.getAll('environment').length !== 1 || target.searchParams.get('environment') !== scope.environment) return false;
  if (path === 'context') return method === 'GET';
  if (scope.locationId && (target.searchParams.getAll('locationId').length !== 1 || target.searchParams.get('locationId') !== scope.locationId)) return false;
  if (method === 'GET') return /^(?:order-proofs(?:\/[A-Za-z0-9_-]+(?:\/case-actions|\/revisions\/[1-9]\d*(?:\/(?:sources|artifacts)\/[A-Za-z0-9_-]+)?)?)?|order-(?:changes|attention|lookup|source-health))$/.test(path);
  return method === 'POST' && /^order-proofs\/[A-Za-z0-9_-]+\/(?:associations|case-actions|revisions\/[1-9]\d*\/packet)$/.test(path);
}
