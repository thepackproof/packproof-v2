import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {inspectHostedLockEvidence} from './hosted-membership-locks.mjs';
import {validateReconstructionReview,reconstructionDigest,validateReconstructionTaskMetadata} from './reconstruction-v10-release-review.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

export function inspectOrderWorkspacePair(review, api, worker, now = new Date()) {
  return {
    schema:'packproof.order-workspace-policy-pair/v1',
    ...inspectWorkspaceRoleReceipts(review, api, worker, now, 'v10', 122, validateReconstructionReview),
  };
}

export function inspectWorkspaceRoleReceipts(review, api, worker, now, version, count, validateReview) {
  const expected = review?.automationPolicy;
  check(review?.schema === `packproof.reconstruction-release-review/${version}` && review.featureActivation === false &&
    review.customerReleaseQualified === false && expected && hex(expected.bundleSha256) && hex(expected.shadowSourcesSha256) &&
    typeof expected.interpretationEnabled === 'boolean' && typeof expected.headerVariantsEnabled === 'boolean' &&
    typeof expected.interpretationVersion === 'string' && typeof expected.headerPolicyVersion === 'string',
    'AUTOMATION_REVIEW_REQUIRED');
  const expectedReview = reconstructionDigest(review);
  validateReview(review,expectedReview,review.source,now);
  for (const [kind, receipt] of [['api', api], ['worker', worker]]) {
    const age = now.getTime() - Date.parse(receipt?.completedAt);
    check(Number.isFinite(age) && age >= 0 && age <= 900000 && Date.parse(review.expiresAt) > now.getTime(),
      'AUTOMATION_OBSERVATION_EXPIRED');
    check(receipt.schema === `packproof.reconstruction-runtime-preflight/${version}` && receipt.kind === kind &&
      receipt.reviewSha256 === expectedReview && receipt.source === review.source && receipt.readOnly === true &&
      receipt.customerReleaseQualified === false && receipt.identity?.role === (kind === 'api' ? review.apiRole : review.workerRole) &&
      receipt.identity?.database === review.target?.database && receipt.taskIdentity?.image === review.candidateImage &&
      receipt.taskIdentity?.imageDigest === review.candidateImage.split('@')[1] && receipt.sourceInventory?.sourceCount === count &&
      receipt.sourceInventory?.appliedCount === count && receipt.sourceInventory?.inventorySha256 === review.inventorySha256 &&
      receipt.sourceInventory?.migrationsApplied === false && receipt.sourceInventory?.rolesChanged === false &&
      receipt.sourceInventory?.featureActivation === false && receipt.backfillJobsEnabled===review.backfillJobsEnabled && receipt.backfillScopeVerified===true && receipt.orderHistoryGuardsVerified===true && receipt.orderWorkspaceEnabled===false && receipt.durabilityPolicyMatches === true, 'AUTOMATION_ROLE_RECEIPT_MISMATCH');
    check(receipt.identity.login === receipt.identity.role && receipt.identity.read_only === 'on' &&
      receipt.identity.schema === 'public' && receipt.tls?.ssl === true && receipt.immutableTriggerVerified === true &&
      receipt.recordsPrivileges?.migrationSha256 === review.recordsMigrationSha256 &&
      receipt.recordsPrivileges?.sourceCommit === review.source && receipt.recordsPrivileges?.caller === receipt.identity.role &&
      hex(receipt.m2PrivilegesSha256), 'AUTOMATION_ROLE_AUTHORITY_MISMATCH');
    inspectHostedLockEvidence(receipt.platformLocks,receipt.identity.role);
    validateReconstructionTaskMetadata({Image:receipt.taskIdentity.image,ImageID:receipt.taskIdentity.imageDigest},{TaskARN:receipt.taskIdentity.taskArn},review);
    const policy = receipt.automationPolicy;
    check(policy?.schema === 'packproof.shipment-policy-role/v1' && policy.kind === kind &&
      policy.bundleSha256 === expected.bundleSha256 && policy.interpretationVersion === expected.interpretationVersion &&
      policy.headerPolicyVersion === expected.headerPolicyVersion, 'AUTOMATION_BUILT_POLICY_MISMATCH');
    if (kind === 'api') check(policy.interpretationEnabled === expected.interpretationEnabled &&
      policy.headerVariantsEnabled === expected.headerVariantsEnabled && policy.shadowSourcesSha256 === expected.shadowSourcesSha256,
      'AUTOMATION_API_SETTINGS_MISMATCH');
    if (expected.interpretationEnabled) check(policy.workerInterpretation === expected.interpretationVersion, 'AUTOMATION_WORKER_INTERPRETATION_MISMATCH');
    if (expected.headerVariantsEnabled) check(policy.workerHeaderPolicy === expected.headerPolicyVersion, 'AUTOMATION_WORKER_HEADER_POLICY_MISMATCH');
  }
  check(api.taskIdentity.taskArn && worker.taskIdentity.taskArn && api.taskIdentity.taskArn !== worker.taskIdentity.taskArn,
    'AUTOMATION_DISTINCT_ROLE_TASKS_REQUIRED');
  return {source:review.source,image:review.candidateImage,reviewSha256:expectedReview,
    platformLockPolicySha256:review.platformLockPolicySha256,inventorySha256:review.inventorySha256,bundleSha256:expected.bundleSha256,apiReceiptSha256:reconstructionDigest(api),
    workerReceiptSha256:reconstructionDigest(worker),featureActivation:false,customerReleaseQualified:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==5)throw Error('BACKFILL_REVIEW_AND_TWO_ROLE_RECEIPTS_REQUIRED');
  const [review,api,worker]=await Promise.all(process.argv.slice(2).map(async path=>JSON.parse(await readFile(path,'utf8'))));
  console.log(JSON.stringify(inspectOrderWorkspacePair(review,api,worker)));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
