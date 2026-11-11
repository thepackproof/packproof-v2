import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const APPROVAL_PATH = '/app/records/connect/approve';
function origin(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without a path or credentials.`);
  }
  return url.origin;
}
export async function verifyHostedApproval(webBaseUrl, apiBaseUrl, fetcher = fetch) {
  const web = origin(webBaseUrl, 'Web URL'), api = origin(apiBaseUrl, 'API URL');
  async function read(path, type) {
    const url = new URL(path, web).href;
    const response = await fetcher(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status !== 200 || (response.url && response.url !== url) || !(response.headers.get('content-type') || '').startsWith(type)) {
      throw new Error(`Hosted approval verification failed for ${path.split('?')[0]}.`);
    }
    return response;
  }
  const manifest = await (await read('/release.json', 'application/json')).json();
  if (!/^[a-f0-9]{40}$/.test(manifest.commit || '') || !/^[a-f0-9]{64}$/.test(manifest.indexSha256 || '') || manifest.apiUrl !== api || manifest.approvalPath !== APPROVAL_PATH || manifest.capabilities?.connectApproval !== 1) {
    throw new Error('The selected website has no compatible, source-pinned Connect approval release. Publish the matching web application before building an installer.');
  }
  const response = await read(`${APPROVAL_PATH}?enrollmentId=release-route-check`, 'text/html');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.indexSha256) {
    throw new Error('The approval URL does not serve the published application. A redirect, stale cache, or unrelated page is still active.');
  }
  return { webOrigin: web, apiOrigin: api, webCommit: manifest.commit, approvalPath: APPROVAL_PATH };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyHostedApproval(process.env.PACKPROOF_WEB_BASE_URL || '', process.env.PACKPROOF_API_BASE_URL || '')
    .then(result => console.log(JSON.stringify({ hostedApprovalVerified: true, ...result })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
