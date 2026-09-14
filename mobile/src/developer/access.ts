import type { PackProofV2Client } from '../v2-api';

export type DeveloperTenant = { id: string; name: string; environment: 'sandbox' | 'live' };
export type DeveloperKey = { id: string; name: string; prefix: string; scopes: string[]; revokedAt: string | null };
export type DeveloperWorkspaces = { tenants: DeveloperTenant[]; availableScopes: string[] };
type Client = Pick<PackProofV2Client, 'apiBaseUrl' | 'assertCaptureAccount' | 'developerRequest'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const scope = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(value);

export function readDeveloperTenant(value: unknown): DeveloperTenant {
  if (!object(value) || !identifier(value.id) || typeof value.name !== 'string' || !['sandbox', 'live'].includes(String(value.environment))) throw new Error('Workspace details could not be verified. Refresh and try again.');
  return { id: value.id, name: value.name, environment: value.environment as DeveloperTenant['environment'] };
}
export function readDeveloperWorkspaces(value: unknown): DeveloperWorkspaces {
  if (!object(value) || !Array.isArray(value.tenants) || !Array.isArray(value.availableScopes) || !value.availableScopes.every(scope)) throw new Error('Developer access is temporarily unavailable.');
  return { tenants: value.tenants.map(readDeveloperTenant), availableScopes: [...new Set(value.availableScopes)] };
}
export function readDeveloperKeys(value: unknown): DeveloperKey[] {
  if (!object(value) || !Array.isArray(value.keys)) throw new Error('API keys could not be loaded.');
  return value.keys.map(row => {
    if (!object(row) || !identifier(row.id) || typeof row.name !== 'string' || typeof row.prefix !== 'string' || row.prefix.length > 20 || !Array.isArray(row.scopes) || !row.scopes.every(scope) || (row.revokedAt !== null && (typeof row.revokedAt !== 'string' || !Number.isFinite(Date.parse(row.revokedAt))))) throw new Error('API key details could not be verified.');
    // Never carry extra fields (including a raw token) from the list endpoint into display state.
    return { id: row.id, name: row.name, prefix: row.prefix, scopes: [...row.scopes], revokedAt: row.revokedAt as string | null };
  });
}
export function readIssuedToken(value: unknown, environment: DeveloperTenant['environment']): string {
  if (!object(value) || typeof value.token !== 'string' || !new RegExp(`^pp_${environment}_[A-Za-z0-9_-]{43}$`).test(value.token)) throw new Error('The new API key could not be shown safely. Refresh the key list before trying again.');
  return value.token;
}
export function leastDeveloperScopes(available: readonly string[]): string[] { return available.includes('proofs:read') ? ['proofs:read'] : []; }
export function developerKeyPath(tenantId: string, keyId?: string, rotate = false): string {
  return `/${encodeURIComponent(tenantId)}/keys${keyId === undefined ? '' : `/${encodeURIComponent(keyId)}${rotate ? '/rotate' : ''}`}`;
}
export class StaleDeveloperRequest extends Error {
  constructor() { super('Developer access changed. Refresh the current workspace.'); }
}
/** Old request cleanup cannot unlock an action started for a replacement account/API scope. */
export class DeveloperActionLock {
  private owner: object | null = null;
  busy(owner: object) { return this.owner === owner; }
  enter(owner: object) { if (this.owner === owner) return false; this.owner = owner; return true; }
  leave(owner: object) { if (this.owner !== owner) return false; this.owner = null; return true; }
}
/** Each asynchronous action retains its original account, API, tenant and foreground lifetime. */
export class DeveloperAccessScope {
  private revision = 0;
  private tenant = '';
  private foreground = true;
  private disposed = false;
  private readonly apiBaseUrl: string;
  constructor(private readonly client: Client, private readonly userId: string, private readonly isCurrent: () => boolean = () => true) { this.apiBaseUrl = client.apiBaseUrl; }
  selectTenant(tenantId: string) { this.tenant = tenantId; this.revision += 1; }
  reconcileTenants(tenantIds: readonly string[]): boolean {
    if (this.tenant && !tenantIds.includes(this.tenant)) { this.selectTenant(''); return true; }
    return false;
  }
  setForeground(value: boolean) { if (value !== this.foreground) { this.foreground = value; this.revision += 1; } }
  dispose() { this.disposed = true; this.revision += 1; }
  lease(requireTenant = false) {
    const revision = this.revision, tenantId = this.tenant;
    const assert = () => {
      if (this.disposed || !this.isCurrent() || !this.foreground || revision !== this.revision || (requireTenant && !tenantId) || this.client.apiBaseUrl !== this.apiBaseUrl) throw new StaleDeveloperRequest();
      this.client.assertCaptureAccount(this.userId, this.apiBaseUrl);
    };
    assert();
    return { tenantId, assert, request: async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      assert(); const result = await this.client.developerRequest<T>(path, method, body); assert(); return result;
    } };
  }
}
