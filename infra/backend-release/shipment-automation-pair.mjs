// Read-only role evidence and offline comparison. The caller supplies original
// read-only ECS preflight reports; no mutation or activation is performed here.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {reconstructionDigest, validateReconstructionReview, validateReconstructionTaskMetadata} from './reconstruction-v7-release-review.mjs';

const files = [
  'index.js', 'records/agent-restrictions.js', 'records/connect-csv-rules.json',
  'records/csv-header-policy.js', 'records/csv-semantics.js', 'records/csv.js',
  'records/partner-imports.js', 'records/shipment-interpretation-shadow.js',
  'records/source-subscriptions.js', 'records/typed-imports.js',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const check = (ok, code) => { if (!ok) throw Error(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function readShipmentAutomationPolicy(kind, env = process.env, dist = '/app/backend/dist') {
  check(kind === 'api' || kind === 'worker', 'AUTOMATION_PROCESS_ROLE_REQUIRED');
  const manifest = await Promise.all(files.map(async file => [file, digest(await readFile(join(dist, file)))]));
  const rules = JSON.parse(await readFile(join(dist, 'records/connect-csv-rules.json'), 'utf8'));
  const policy = await import(pathToFileURL(join(dist, 'records/csv-header-policy.js')).href);
  check(typeof rules.interpretation?.version === 'string' && typeof policy.CSV_REORDER_POLICY === 'string', 'AUTOMATION_BUILT_POLICY_MISSING');
  const enabled = name => {
    check([undefined, '', 'true', 'false'].includes(env[name]), 'AUTOMATION_FEATURE_SWITCH_INVALID');
    return env[name] === 'true';
  };
  const scopes = (env.PACKPROOF_SHIPMENT_INTERPRETATION_SHADOW_SOURCES ?? '').split(',').map(s => s.trim()).filter(Boolean).sort();
  check(scopes.every(s => /^[^\s,:]+:[1-9][0-9]*$/.test(s)) && new Set(scopes).size === scopes.length, 'AUTOMATION_SHADOW_SCOPE_INVALID');
  return {
    schema:'packproof.shipment-policy-role/v1', kind, bundleSha256:reconstructionDigest(manifest),
    interpretationVersion:rules.interpretation.version, headerPolicyVersion:policy.CSV_REORDER_POLICY,
    interpretationEnabled:enabled('PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED'),
    headerVariantsEnabled:enabled('PACKPROOF_CSV_HEADER_VARIANTS_ENABLED'),
    workerInterpretation:env.PACKPROOF_SHIPMENT_WORKER_INTERPRETATION || null,
    workerHeaderPolicy:env.PACKPROOF_CSV_HEADER_WORKER_POLICY || null,
    shadowSourcesSha256:reconstructionDigest(scopes), shadowSourceCount:scopes.length,
  };
}

export function inspectShipmentAutomationPair(review, api, worker, now = new Date()) {
  const expected = review?.automationPolicy;
  check(review?.schema === 'packproof.reconstruction-release-review/v7' && review.featureActivation === false &&
    review.customerReleaseQualified === false && expected && hex(expected.bundleSha256) && hex(expected.shadowSourcesSha256) &&
    typeof expected.interpretationEnabled === 'boolean' && typeof expected.headerVariantsEnabled === 'boolean' &&
    typeof expected.interpretationVersion === 'string' && typeof expected.headerPolicyVersion === 'string',
    'AUTOMATION_REVIEW_REQUIRED');
  const expectedReview = reconstructionDigest(review);
  validateReconstructionReview(review,expectedReview,review.source,now);
  for (const [kind, receipt] of [['api', api], ['worker', worker]]) {
    const age = now.getTime() - Date.parse(receipt?.completedAt);
    check(Number.isFinite(age) && age >= 0 && age <= 900000 && Date.parse(review.expiresAt) > now.getTime(),
      'AUTOMATION_OBSERVATION_EXPIRED');
    check(receipt.schema === 'packproof.reconstruction-runtime-preflight/v7' && receipt.kind === kind &&
      receipt.reviewSha256 === expectedReview && receipt.source === review.source && receipt.readOnly === true &&
      receipt.customerReleaseQualified === false && receipt.identity?.role === (kind === 'api' ? review.apiRole : review.workerRole) &&
      receipt.identity?.database === review.target?.database && receipt.taskIdentity?.image === review.candidateImage &&
      receipt.taskIdentity?.imageDigest === review.candidateImage.split('@')[1] && receipt.sourceInventory?.sourceCount === 120 &&
      receipt.sourceInventory?.appliedCount === 120 && receipt.sourceInventory?.inventorySha256 === review.inventorySha256 &&
      receipt.sourceInventory?.migrationsApplied === false && receipt.sourceInventory?.rolesChanged === false &&
      receipt.sourceInventory?.featureActivation === false && receipt.durabilityPolicyMatches === true, 'AUTOMATION_ROLE_RECEIPT_MISMATCH');
    check(receipt.identity.login === receipt.identity.role && receipt.identity.read_only === 'on' &&
      receipt.identity.schema === 'public' && receipt.tls?.ssl === true && receipt.immutableTriggerVerified === true &&
      receipt.recordsPrivileges?.migrationSha256 === review.recordsMigrationSha256 &&
      receipt.recordsPrivileges?.sourceCommit === review.source && receipt.recordsPrivileges?.caller === receipt.identity.role &&
      hex(receipt.m2PrivilegesSha256), 'AUTOMATION_ROLE_AUTHORITY_MISMATCH');
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
  return {schema:'packproof.shipment-policy-pair/v1',source:review.source,image:review.candidateImage,reviewSha256:expectedReview,
    inventorySha256:review.inventorySha256,bundleSha256:expected.bundleSha256,apiReceiptSha256:reconstructionDigest(api),
    workerReceiptSha256:reconstructionDigest(worker),featureActivation:false,customerReleaseQualified:false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'manifest') {
      check(process.argv.length === 4,'AUTOMATION_BUILD_DIRECTORY_REQUIRED');
      const p=await readShipmentAutomationPolicy('worker',{},process.argv[3]);
      console.log(JSON.stringify({schema:'packproof.shipment-policy-build/v1',bundleSha256:p.bundleSha256,
        interpretationVersion:p.interpretationVersion,headerPolicyVersion:p.headerPolicyVersion}));
    } else {
      const [reviewPath,apiPath,workerPath] = process.argv.slice(2);
      check(process.argv.length===5, 'AUTOMATION_REVIEW_AND_TWO_ROLE_RECEIPTS_REQUIRED');
      const [review,api,worker] = await Promise.all([reviewPath,apiPath,workerPath].map(async p=>JSON.parse(await readFile(p,'utf8'))));
      console.log(JSON.stringify(inspectShipmentAutomationPair(review,api,worker)));
    }
  } catch(error) {
    console.error(JSON.stringify({event:'shipment_policy_pair_failed',code:/^AUTOMATION_[A-Z_]+$/.test(error?.message??'')?error.message:'AUTOMATION_PAIR_INPUT_INVALID'}));
    process.exitCode = 1;
  }
}
