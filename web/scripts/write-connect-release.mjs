import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function releaseConfig(env) {
  const commit = env.PACKPROOF_WEB_RELEASE_COMMIT;
  const api = new URL(env.VITE_PACKPROOF_API_BASE_URL || '');
  const region = env.VITE_PACKPROOF_COGNITO_REGION;
  const userPoolId = env.VITE_PACKPROOF_COGNITO_USER_POOL_ID;
  const clientId = env.VITE_PACKPROOF_COGNITO_CLIENT_ID;
  const environment = env.PACKPROOF_WEB_RELEASE_ENVIRONMENT || 'production';
  if (!/^[a-f0-9]{40}$/.test(commit || '') || api.protocol !== 'https:' ||
      api.pathname !== '/' || api.search || api.hash || api.username || api.password ||
      !['production', 'staging'].includes(environment)) {
    throw Error('An exact source commit, environment and HTTPS API origin are required.');
  }
  if (env.VITE_PACKPROOF_AUTH_MODE !== 'cognito' || !/^[a-z]{2}-[a-z-]+-\d+$/.test(region || '') ||
      !userPoolId?.startsWith(region + '_') || !/^[A-Za-z0-9]+$/.test(userPoolId.slice(region.length + 1)) ||
      !/^[a-z0-9]{1,128}$/.test(clientId || '')) throw Error('The portal build requires its Cognito pool and public app client.');
  return { commit, apiUrl: api.origin, environment, auth: { mode: 'cognito', region, userPoolId, clientId } };
}

async function files(dir, base = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = base + entry.name;
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), name + '/'));
    else if (entry.isFile() && name !== 'release.json') {
      const bytes = await readFile(path.join(dir, entry.name));
      result.push({ path: name, sha256: digest(bytes), byteSize: bytes.length });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeConnectRelease(dir = root, env = process.env) {
  const config = releaseConfig(env);
  const assets = await files(dir);
  const index = assets.find(x => x.path === 'index.html');
  const scripts = await Promise.all(assets.filter(x => x.path.endsWith('.js')).map(x => readFile(path.join(dir, x.path), 'utf8')));
  const markers = [config.commit, config.apiUrl, config.auth.userPoolId, config.auth.clientId,
    'packproof.connect.approval-return.v1', 'Review this collection computer', 'Approve collection', 'workspaceSession', '/order-workspace/'];
  if (!index || !markers.every(marker => scripts.some(script => script.includes(marker)))) {
    throw Error('The compiled application does not match the selected clean source, authentication settings and approval capabilities.');
  }
  const release = { schema: 'packproof.web-release/v1', ...config, indexSha256: index.sha256,
    approvalPath: '/app/records/connect/approve', capabilities: { connectApproval: 1, orderWorkspaceApproval: 1 }, assets };
  await writeFile(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await writeConnectRelease();
  console.log(JSON.stringify({ commit: r.commit, indexSha256: r.indexSha256, files: r.assets.length, apiUrl: r.apiUrl }));
}
