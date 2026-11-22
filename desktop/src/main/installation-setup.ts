export interface InstallationSetupLocator {
  installationId: string;
  environment: 'sandbox' | 'live';
  organizationId?: string;
}
export interface InstallationSetupAccess {
  installationId: string;
  organizationId: string;
  environment: 'sandbox' | 'live';
  locationId: string | null;
  state: 'setup' | 'ready' | 'active' | 'paused' | 'revoked';
  userId: string;
}
type Read = (path: string) => Promise<unknown>;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const unavailable = () => Error('An administrator of this computer’s workspace must sign in to review its connection.');

/** The existing human installation endpoint rechecks current OWNER/ADMIN authority.
 * These reads prove permission to manage this exact installation, never permission
 * to read orders, inspect local sources, or change its immutable facility binding. */
export async function readInstallationSetupAccess(locator: InstallationSetupLocator, userId: string, read: Read): Promise<InstallationSetupAccess> {
  if (!validId(locator.installationId) || !validId(userId) || !['sandbox', 'live'].includes(locator.environment) ||
      (locator.organizationId !== undefined && !validId(locator.organizationId))) throw unavailable();
  // Revoked native status deliberately omits its former binding. Resolve only
  // among the signed-in human's current administrator workspaces; no email lookup.
  // Context also supplies current location grants, including for a known workspace.
  const context = await read('/me/records/context') as { organizations?: unknown };
  if (!Array.isArray(context?.organizations)) throw unavailable();
  const organizations = context.organizations.filter((row): row is { id: string; locations: { id: string }[] } =>
    !!row && typeof row === 'object' && validId(row.id) && row.enabled === true &&
    row.environment === locator.environment && ['OWNER', 'ADMIN'].includes(row.role) &&
    Array.isArray(row.locations) && (!locator.organizationId || row.id === locator.organizationId));
  if (organizations.length > 20 || new Set(organizations.map(row => row.id)).size !== organizations.length) throw unavailable();
  let found: InstallationSetupAccess | undefined;
  for (const organization of organizations) {
    const organizationId = organization.id;
    const query = new URLSearchParams({ organizationId, environment: locator.environment });
    let value: unknown;
    try { value = await read('/me/records/agent-installations/' + encodeURIComponent(locator.installationId) + '?' + query); }
    catch (error) {
      if (!locator.organizationId && error && typeof error === 'object' && 'status' in error && error.status === 404) continue;
      throw error;
    }
    const row = value as Partial<InstallationSetupAccess> & { id?: unknown };
    if (!row || row.id !== locator.installationId || row.organizationId !== organizationId || row.environment !== locator.environment ||
        !(row.locationId === null || validId(row.locationId)) || !['setup', 'ready', 'active', 'paused', 'revoked'].includes(row.state ?? '')) throw unavailable();
    if (row.locationId !== null && !organization.locations.some(site => site && site.id === row.locationId)) throw unavailable();
    if (found) throw unavailable();
    found = { installationId: locator.installationId, organizationId, environment: locator.environment,
      locationId: row.locationId!, state: row.state!, userId };
  }
  if (!found) throw unavailable();
  return found;
}
