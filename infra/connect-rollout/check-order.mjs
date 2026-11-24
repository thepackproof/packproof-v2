// Read one operator-selected Proof and compare it to the Windows export.
import { pathToFileURL } from 'node:url';
import { verifyOutput } from '../../examples/multisource-journey/verify-output.mjs';
import { verifyHostedApproval } from '../../connect-windows/scripts/verify-hosted-approval.mjs';
import { target } from '../connect-portal-release.mjs';

export async function checkOrder({ source, organizationId, environment, proofId, output, token }, {
  fetcher = fetch, checkPortal = verifyHostedApproval, checkLocal = verifyOutput,
} = {}) {
  const workspaceEnvironment = environment === 'production' ? 'live' : environment;
  if (!/^[a-f0-9]{40}$/.test(source) || !organizationId || !['sandbox', 'live'].includes(workspaceEnvironment) ||
      !proofId || !output || !token) throw Error('Source, organization, environment, Proof, output folder and signed-in operator token are required.');
  async function get(endpoint, authenticated) {
    const url = new URL(endpoint, target.api);
    if (authenticated) {
      url.searchParams.set('organizationId', organizationId);
      url.searchParams.set('environment', workspaceEnvironment);
    }
    const response = await fetcher(url, { headers: authenticated ? { Authorization: 'Bearer ' + token } : {},
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw Error('The hosted PackProof check failed (HTTP ' + response.status + ').');
    }
    return response.json();
  }
  const meta = await get('/meta', false);
  if (meta.commit !== source || meta.environment !== 'production') throw Error('Unexpected running API release.');
  await checkPortal(target.web, target.api, fetcher, { requireOrderWorkspace: true, expectedCommit: source });
  const context = await get('/me/records/context', true);
  if (context.selectedOrganizationId !== organizationId || context.environment !== workspaceEnvironment ||
      context.capabilities?.orderProofs !== true) throw Error('The selected organization has no active Proof workspace.');
  const receipt = await get('/me/records/order-proofs/' + encodeURIComponent(proofId), true);
  if (receipt.proofId !== proofId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw Error('The API did not return the selected Proof.');
  }
  let local;
  try { local = await checkLocal(output, receipt); }
  catch { throw Error('The local Proof and the latest hosted revision do not agree. Allow pending exports to finish, then retry.'); }
  return { source, revision: receipt.revision, filesVerified: local.filesVerified, verifiedAt: local.verifiedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, organizationId, environment, proofId, output] = process.argv.slice(2);
  checkOrder({ source, organizationId, environment, proofId, output, token: process.env.PACKPROOF_OPERATOR_TOKEN })
    .then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
