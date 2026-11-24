import { createHash } from 'node:crypto';

const APPROVAL_PATH = '/app/records/connect/approve';
function origin(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without a path or credentials.`);
  }
  return url.origin;
}
export async function verifyHostedApproval(webBaseUrl, apiBaseUrl, fetcher = fetch, { requireOrderWorkspace = false, expectedCommit, expectedEnvironment } = {}) {
  const web = origin(webBaseUrl, 'Web URL'), api = origin(apiBaseUrl, 'API URL');
  async function read(path, type, base = web) {
    const url = new URL(path, base).href;
    const response = await fetcher(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status !== 200 || (response.url && response.url !== url) || !(response.headers.get('content-type') || '').startsWith(type)) {
      throw new Error(`Hosted approval verification failed for ${path.split('?')[0]}.`);
    }
    return response;
  }
  const manifest = await (await read('/release.json', 'application/json')).json();
  if (!/^[a-f0-9]{40}$/.test(manifest.commit || '') || !/^[a-f0-9]{64}$/.test(manifest.indexSha256 || '') || manifest.apiUrl !== api || manifest.approvalPath !== APPROVAL_PATH || manifest.capabilities?.connectApproval !== 1) {
    throw new Error('The selected website has no compatible, source-pinned Connect approval release.');
  }
  if (expectedCommit !== undefined && (!/^[a-f0-9]{40}$/.test(expectedCommit) || manifest.commit !== expectedCommit)) {
    throw new Error('Hosted approval does not match the reviewed portal commit.');
  }
  if (expectedEnvironment !== undefined && (!['staging', 'production'].includes(expectedEnvironment) || manifest.environment !== expectedEnvironment || manifest.auth?.mode !== 'cognito')) {
    throw new Error('Hosted approval needs the matching release environment and Cognito sign-in.');
  }
  if (expectedEnvironment && expectedCommit) {
    const meta = await (await read('/meta', 'application/json', api)).json();
    if (meta.commit !== expectedCommit) throw new Error('Hosted API does not match the reviewed release commit.');
  }
  const supportsOrderWorkspace = manifest.capabilities.orderWorkspaceApproval === 1;
  if (requireOrderWorkspace && !supportsOrderWorkspace) {
    throw new Error('The web portal must support multi-source approval.');
  }
  const locators = ['enrollmentId=release-route-check'];
  if (supportsOrderWorkspace) locators.push(`installationId=release-route-check&organizationId=release-check&environment=${expectedEnvironment === 'production' ? 'live' : 'sandbox'}&workspaceSession=release-check`);
  for (const locator of locators) {
    const response = await read(`${APPROVAL_PATH}?${locator}`, 'text/html');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.indexSha256) {
      throw new Error('The approval URL does not serve the published application. A redirect, stale cache, or unrelated page is still active.');
    }
  }
  return { webOrigin: web, apiOrigin: api, webCommit: manifest.commit, approvalPath: APPROVAL_PATH, supportsOrderWorkspace };
}
