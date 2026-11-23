import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {hostedCollectorTarget as target,reconstructionDigest as digest} from './reconstruction-v11-release-review.mjs';
import {validateRecoveryOwnerReview} from './recovery-hosted-migration.mjs';
import {ownerRegistration,ownerRunRequest,verifyOwnerInspection,verifyCompletedTask} from './connect-hosted-owner-task.mjs';
import {verifyRecoveryRelease} from './recovery-runtime-release.mjs';

const collectorInventory='8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
const inventory='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
const prefix='packproof-recovery-owner-';
const check=(ok,reason)=>{if(!ok)throw Error('CONNECT_RECOVERY_OWNER_'+reason);};
const profile=Object.freeze({
  familyPrefix:prefix,command:'/release/recovery-hosted-migration.mjs',receipt:'packproof.hosted-recovery-owner-receipt/v1',
  validate:validateRecoveryOwnerReview,requireInspection:true,preserveLegacyWorkspace:true,
  checkBridge(observation,kind) {
    const gated=['PACKPROOF_GUIDED_FACILITIES','PACKPROOF_SETUP_AI_FACILITIES'];
    const definitions=[...observation.taskDefinition.containerDefinitions];
    if(kind==='api')definitions.push(observation.express.activeConfigurations[0].primaryContainer);
    check(definitions.every(container=>(container.environment??[]).every(v=>!gated.includes(v.name)||!v.value) &&
      (container.secrets??[]).every(v=>!gated.includes(v.name))), 'BRIDGE_FEATURES_ENABLED');
  },
});
const additions=['130_connect_recovery_collector_version'];

function registeredImage(response,tag) {
  const details=response?.imageDetails;
  const [account,repository]=[target.repository.split('.')[0],target.repository.split('/')[1]];
  check(details?.length===1 && details[0].registryId===account && details[0].repositoryName===repository &&
    details[0].imageTags?.includes(tag) && /^sha256:[a-f0-9]{64}$/.test(details[0].imageDigest),'REGISTRY_IMAGE');
  return target.repository+'@'+details[0].imageDigest;
}

export function createRecoveryOwnerReview({snapshot,release,expiresAt,inspection},now=new Date()) {
  // Require the actual successful source-bound build and its publication log,
  // not merely plausible registry tags and an unattached CI response.
  verifyRecoveryRelease(release);
  const build=release?.images, ci=release?.ci, source=build?.source;
  check(build?.schema==='packproof.recovery-images/v1' && /^[a-f0-9]{40}$/.test(source??'') &&
    build.inventorySha256===inventory && build.previousInventorySha256===collectorInventory &&
    build.candidateTag==='recovery-v1-'+source && build.fallbackTag==='recovery-compat-'+source &&
    typeof build.predecessorImage==='string' && build.predecessorImage.startsWith(target.repository+'@') &&
    /^sha256:[a-f0-9]{64}$/.test(build.predecessorImage.split('@')[1]) && build.predecessorImage.split('@').length===2,'BUILD_RECEIPT');
  check(ci?.repository?.full_name==='thepackproof/packproof-v2' && ci.name==='CI' && ci.path==='.github/workflows/ci.yml' &&
    ci.status==='completed' && ci.conclusion==='success' && ci.head_sha===source && ci.head_branch==='main' &&
    ['push','workflow_dispatch'].includes(ci.event),'SOURCE_CI');
  const candidateImage=registeredImage(release.candidate,build.candidateTag);
  const bridgeImage=registeredImage(release.fallback,build.fallbackTag);
  check(new Set([candidateImage,bridgeImage,build.predecessorImage]).size===3,'DISTINCT_IMAGES');
  const review={schema:'packproof.hosted-recovery-migration/v1',source,candidateImage,bridgeImage,
    clusterArn:target.clusterArn,target:{host:target.host,database:target.database},inventorySha256:inventory,
    apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',ownerRole:'packproof',expiresAt,
    ownerLaunch:structuredClone(snapshot.ownerLaunch)};
  if(inspection)review.expectedLedger=verifyOwnerInspection(inspection,review,now,profile);
  ownerRegistration({mode:inspection?'rehearse':'inspect',review,snapshot,inspection},now,profile);
  return review;
}

export function registerRecoveryOwner(input,now=new Date()) {
  return ownerRegistration(input,now,profile);
}
export function runRecoveryOwner(input,now=new Date()) {
  return ownerRunRequest(input,now,profile);
}

// Reconstruct the approved write task and confirm the independently observed committed ledger.
export function verifyRecoveryApplication(input,now=new Date()) {
  const {review,inspection,rehearsal,confirmation,postInspection}=input;
  const report=confirmation?.report;
  const expected=registerRecoveryOwner({...input,mode:'apply'},now);
  verifyCompletedTask(confirmation,expected,review.candidateImage);
  check(report?.schema===profile.receipt && report.mode==='apply' && report.rolledBack===false &&
    report.source===review.source && report.image===review.candidateImage && report.reviewSha256===digest(review) &&
    report.targetHost===review.target.host && report.initialLedger===review.expectedLedger && report.finalLedger===inventory &&
    digest(report.applied)===digest(report.initialLedger===inventory?[]:additions), 'APPLY_RECEIPT');
  check(verifyOwnerInspection(postInspection,review,now,profile)===inventory,'POST_APPLY_LEDGER');
  const sequence=[inspection,rehearsal,confirmation,postInspection].map(task=>task.report);
  const times=sequence.map(item=>Date.parse(item.completedAt));
  check(new Set(sequence.map(item=>item.actualTask)).size===4 && times.every((t,i)=>Number.isFinite(t) &&
    t<=now.getTime() && (i===0||t>=times[i-1])),'TASK_SEQUENCE');
  return {schema:'packproof.hosted-recovery-migration-verified/v1',source:review.source,reviewSha256:digest(review),
    candidateImage:review.candidateImage,bridgeImage:review.bridgeImage,previousLedger:report.initialLedger,
    finalLedger:report.finalLedger,applied:report.applied,tasks:sequence.map(item=>item.actualTask)};
}

async function main(){
  const [phase,from,to]=process.argv.slice(2);
  check(process.argv.length===5 && ['review','register','run','verify-apply'].includes(phase),'CLI');
  const input=JSON.parse(await readFile(from,'utf8'));
  let output;
  if(phase==='review')output=createRecoveryOwnerReview(input);
  else if(phase==='verify-apply')output=verifyRecoveryApplication(input);
  else output={service_name:'ecs',operation_name:phase==='register'?'RegisterTaskDefinition':'RunTask',region_name:'us-east-1',
    params:phase==='register'?registerRecoveryOwner(input):runRecoveryOwner(input)};
  await writeFile(to,JSON.stringify(output,null,2)+'\n',{mode:0o600,flag:'wx'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(/^[A-Z0-9_]+$/.test(e?.message)?e.message:'CONNECT_RECOVERY_OWNER_INPUT_FAILED');process.exitCode=1;
});
