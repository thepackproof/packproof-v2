import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {inspectWorkspaceRoleReceipts} from './order-workspace-pair.mjs';
import {workspaceInventory} from './reconstruction-v10-release-review.mjs';
import {collectorGrants,collectorMigration,validateHostedCollectorReview,validateReconstructionReview} from './reconstruction-v11-release-review.mjs';

export function inspectCollectorVersionPair(review, api, worker, now = new Date()) {
  return inspectCollectorPair(review,api,worker,now,'v11',validateReconstructionReview);
}
export function inspectHostedCollectorPair(review,api,worker,now=new Date()) {
  return inspectCollectorPair(review,api,worker,now,'v11-hosted',validateHostedCollectorReview);
}
function inspectCollectorPair(review,api,worker,now,version,validateReview) {
  const pair = inspectWorkspaceRoleReceipts(review, api, worker, now, version, 123, validateReview);
  for (const receipt of [api, worker]) {
    const additions = receipt.sourceInventory.additions;
    if (receipt.collectorVersionVerified !== true ||
        receipt.sourceInventory.predecessorSha256 !== workspaceInventory ||
        !Array.isArray(additions) || additions.length !== 1 ||
        additions[0]?.id !== collectorMigration.id || additions[0]?.checksum !== collectorMigration.checksum) {
      throw Error('COLLECTOR_VERSION_ROLE_RECEIPT_MISMATCH');
    }
    const privileges = receipt.recordsPrivileges;
    if (privileges.policySha256 !== collectorGrants || !/^[a-f0-9]{64}$/.test(privileges.effectivePrivilegesSha256 ?? '') ||
        privileges.effectivePrivilegesSha256 !== api.recordsPrivileges.effectivePrivilegesSha256) {
      throw Error('COLLECTOR_ROLE_PRIVILEGES_MISMATCH');
    }
    if (receipt.automationPolicy.interpretationEnabled !== review.automationPolicy.interpretationEnabled ||
        receipt.automationPolicy.headerVariantsEnabled !== review.automationPolicy.headerVariantsEnabled ||
        receipt.automationPolicy.shadowSourcesSha256 !== review.automationPolicy.shadowSourcesSha256) {
      throw Error('COLLECTOR_ROLE_POLICY_MISMATCH');
    }
  }
  return {schema:'packproof.collector-version-policy-pair/v1', ...pair, collectorVersionVerified:true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw Error('COLLECTOR_REVIEW_AND_TWO_ROLE_RECEIPTS_REQUIRED');
    const [review,api,worker] = await Promise.all(process.argv.slice(2).map(async file => JSON.parse(await readFile(file,'utf8'))));
    console.log(JSON.stringify(inspectCollectorVersionPair(review,api,worker)));
  } catch (error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
