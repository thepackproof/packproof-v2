// Assemble the operator's release review from private observations and verified release outputs.
import {readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {verifyExisting} from '../connect-rollout/publish-staged-images.mjs';
import {connectConfigurationLease,connectProbeRegistrations} from './connect-runtime-release.mjs';
import {hostedLockPolicySha256} from './hosted-membership-locks.mjs';
import {backfillMigrationInventorySha256,backfillRecordsInventorySha256} from './reconstruction-v8-release-review.mjs';
import {collectorInventory,collectorRecords,hostedCollectorTarget as target,reconstructionDigest} from './reconstruction-v11-release-review.mjs';
import {ownerRegistration,verifyOwnerInspection,verifyService} from './connect-hosted-owner-task.mjs';

const profiles={
  bridge:{profile:'collector-hosted-bridge',tag:'collector-compat-',version:'v9',inventory:backfillMigrationInventorySha256,records:backfillRecordsInventorySha256,reader:'backfill-rollback-reader-probe.mjs'},
  candidate:{profile:'reconstruction-v11',tag:'connect-runtime-',version:'v11-hosted',inventory:collectorInventory,records:collectorRecords,reader:'order-workspace-rollback-reader.mjs'},
};
const roles={apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',ownerRole:'packproof'};
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const imagePattern=new RegExp('^'+TARGET.repository.replaceAll('.','\\.')+'@sha256:[0-9a-f]{64}$');
const check=(ok,reason)=>{if(!ok)throw Error('HOSTED_REVIEW_'+reason);};
const env=container=>Object.fromEntries((container.environment??[]).map(({name,value})=>[name,value]));

function publishedImage(kind, evidence, source, publication) {
  const profile=profiles[kind], baseTag=profile.tag+source;
  if(publication===undefined) {
    const detail=evidence?.imageDetail;
    check(detail?.registryId===TARGET.account&&detail.repositoryName===TARGET.serviceName&&
      detail.imageTags?.includes(baseTag)&&/^sha256:[0-9a-f]{64}$/.test(detail.imageDigest??''),'ECR_IMAGE_'+kind.toUpperCase());
    return TARGET.repository+'@'+detail.imageDigest;
  }
  check(publication?.schema==='packproof.connect-registry-publication/v1'&&publication.mode==='publish'&&
    publication.source===source&&Array.isArray(publication.images)&&publication.images.length===2,'REGISTRY_PUBLICATION');
  const rows=publication.images.filter(entry=>entry.profile===profile.profile);
  check(rows.length===1,'REGISTRY_PROFILE');
  const row=rows[0],tag=row.published?.tag;
  check(/^sha256:[0-9a-f]{64}$/.test(row.imageId??'')&&row.contentTag===baseTag+'-'+row.imageId.slice(7)&&
    (tag===baseTag||tag===row.contentTag),'REGISTRY_SOURCE_AND_CONFIG_TAG');
  const remote=verifyExisting(evidence?.manifestResponse??{},tag,row);
  check(remote&&row.published.digest===remote.digest&&row.published.image===remote.image,'REGISTRY_MANIFEST_PIN');
  return remote.image;
}

function readEvidence({packet,ci,bridge,candidate,publication}) {
  const source=packet?.source;
  check(packet?.schema==='packproof.connect-rollout/v1'&&/^[0-9a-f]{40}$/.test(source??'')&&
    packet.migrationInventorySha256===collectorInventory&&imagePattern.test(packet.approvedPredecessorImage)&&
    typeof packet.version==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+$/.test(packet.version),'PACKET');
  const archives=packet.files?.filter(file=>file.path==='backend.zip');
  check(archives?.length===1&&hex(archives[0].sha256),'PACKET_ARCHIVE');
  check((ci?.name==='CI'||ci?.workflowName==='CI')&&ci.headSha===source&&ci.conclusion==='success','SUCCESSFUL_SOURCE_CI');
  const images={};
  for(const [kind,evidence] of Object.entries({bridge,candidate})) {
    const image=publishedImage(kind,evidence,source,publication),policyEvent=evidence?.policyEvent;
    check(policyEvent?.event==='shipment_release_build_policy'&&hex(policyEvent.bundleSha256),'BUILT_POLICY_'+kind.toUpperCase());
    images[kind]={image,bundle:policyEvent.bundleSha256};
  }
  check(new Set([packet.approvedPredecessorImage,images.bridge.image,images.candidate.image]).size===3,'DISTINCT_IMAGES');
  return {source,version:packet.version,predecessor:packet.approvedPredecessorImage,archive:archives[0].sha256,...images};
}

export function createOwnerReview({snapshot,release,expiresAt,inspection},now=new Date()) {
  const evidence=readEvidence(release);
  const review={schema:'packproof.hosted-collector-migration/v1',source:evidence.source,candidateImage:evidence.candidate.image,
    bridgeImage:evidence.bridge.image,clusterArn:target.clusterArn,target:{host:target.host,database:target.database},
    ...roles,expiresAt,inventorySha256:collectorInventory,ownerLaunch:structuredClone(snapshot.ownerLaunch)};
  if(inspection)review.expectedLedger=verifyOwnerInspection(inspection,review,now);
  ownerRegistration({mode:inspection?'rehearse':'inspect',review,snapshot},now);
  return review;
}

function observedRole(snapshot,kind,expectedImage,expectedSource) {
  const o=snapshot[kind];
  const mains=o.taskDefinition.containerDefinitions.filter(c=>env(c).PACKPROOF_PROCESS_ROLE===kind);
  check(mains.length===1,'PROCESS_ROLE');
  const container=mains[0],source=env(container).PACKPROOF_RELEASE_SHA;
  check(/^[a-f0-9]{40}$/.test(source??'')&&(!expectedSource||source===expectedSource)&&container.image===expectedImage,
    'OBSERVED_PREDECESSOR_'+kind.toUpperCase());
  verifyService(o,kind,{source,image:expectedImage},true);
  return {sourceSha:source,image:expectedImage,taskDefinition:o.taskDefinition.taskDefinitionArn};
}

export function createPairReview({snapshot,release,expiresAt,profile},now=new Date()) {
  const p=profiles[profile];
  check(Object.hasOwn(profiles,profile),'PROFILE');
  const evidence=readEvidence(release),image=evidence[profile].image,candidate=profile==='candidate';
  const prior=candidate?evidence.bridge.image:evidence.predecessor,priorSource=candidate?evidence.source:undefined;
  const expectedApi=observedRole(snapshot,'api',prior,priorSource);
  const expectedWorker={...observedRole(snapshot,'worker',prior,priorSource),
    serviceArn:snapshot.worker.service.serviceArn,clusterArn:snapshot.worker.service.clusterArn};
  const apiEnv=env(snapshot.api.express.activeConfigurations[0].primaryContainer);
  const interpretationEnabled=apiEnv.PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED==='true';
  // The same release validator and role preflights also check that these settings agree
  // across the active Express configuration, task definitions and both database logins.
  const policy={bundleSha256:evidence[profile].bundle,interpretationVersion:'packproof.shipment-interpretation/v1',
    headerPolicyVersion:'same_names_any_order/v1',interpretationEnabled,headerVariantsEnabled:false,shadowSourcesSha256:reconstructionDigest([])};
  const preflightReview={schema:'packproof.reconstruction-release-review/'+p.version,source:evidence.source,candidateImage:image,
    inventorySha256:p.inventory,recordsMigrationSha256:p.records,platformLockPolicySha256:hostedLockPolicySha256,
    ...roles,target:{host:target.host,database:target.database},clusterArn:target.clusterArn,expiresAt,
    featureActivation:false,customerReleaseQualified:false,backfillJobsEnabled:false,...(candidate?{orderWorkspaceEnabled:false}:{}),
    ...(interpretationEnabled?{preserveShipmentSettings:true}:{}),automationPolicy:policy};
  const review={schema:'packproof.connect-runtime-review/'+p.version,sourceSha:evidence.source,image,version:evidence.version,
    environment:'production',database:{host:target.host,name:target.database},apiRole:roles.apiRole,workerRole:roles.workerRole,expiresAt,
    inventorySha256:p.inventory,ciPassed:true,sourceArchiveVerified:true,sourceArchiveSha256:evidence.archive,
    topologySha256:hash(snapshot.topology),configurationLeaseSha256:connectConfigurationLease(snapshot),
    probeClusterArn:target.clusterArn,probeNetworkSha256:hash(snapshot.probe),expectedApi,expectedWorker,preflightReview};
  const reader=readFileSync(new URL(p.reader,import.meta.url),'utf8');
  connectProbeRegistrations(snapshot,review,{reader},now.getTime());
  return review;
}

async function main() {
  const [phase,from,to]=process.argv.slice(2);
  check(process.argv.length===5&&['owner','pair'].includes(phase),'CLI');
  const input=JSON.parse(await readFile(from,'utf8'));
  const review=phase==='owner'?createOwnerReview(input):createPairReview(input);
  await writeFile(to,JSON.stringify(review,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({phase,schema:review.schema,written:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  console.error(/^[A-Z0-9_]+$/.test(error?.message)?error.message:'HOSTED_REVIEW_PRIVATE_INPUT_OR_OUTPUT');process.exitCode=1;
});
