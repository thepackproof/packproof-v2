import {readFileSync} from 'node:fs';
import {backfillMigrationInventorySha256,backfillRecordsInventorySha256,validateReconstructionReview as validateBackfillReview} from './reconstruction-v8-release-review.mjs';
import {validateReconstructionReview as validateHostedReview} from './reconstruction-v9-release-review.mjs';
import {inspectHostedBackfillAutomationPair} from './hosted-backfill-automation-pair.mjs';
import {inspectBackfillAutomationPair} from './backfill-automation-pair.mjs';
import {gzipSync} from 'node:zlib';
import {inspectShipmentAutomationPair} from './shipment-automation-pair.mjs';
import {reconstructionDigest,shipmentMigrationInventorySha256,validateReconstructionReview} from './reconstruction-v7-release-review.mjs';

export const shipmentRecordsInventorySha256='276f345802fb758d75028be0e47b6fab3179c20927317cf30a58aa044e7364de';
export const shipmentRuntimeInventory={count:120,sha256:shipmentMigrationInventorySha256};
const check=(ok,reason)=>{if(!ok)throw Error(reason);};
const offSwitches=new Set(['PACKPROOF_TYPED_INTAKE_ENABLED','PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED',
 'PACKPROOF_MULTI_SOURCE_AGENT_ENABLED','PACKPROOF_CASE_RECONSTRUCTION_ENABLED','PACKPROOF_SOURCE_HEALTH_ENABLED',
 'PACKPROOF_RECONSTRUCTION_RULES_ENABLED','PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED','PACKPROOF_SOURCE_BACKFILL_JOBS_ENABLED',
 'PACKPROOF_SOURCE_DISPOSITION_ENABLED','PACKPROOF_CROSS_CASE_ENABLED','PACKPROOF_SOURCE_IDENTITY_V2_ENABLED',
 'PACKPROOF_SOURCE_RULE_POLICIES_ENABLED','PACKPROOF_PAGED_PROJECTIONS_ENABLED','PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED','PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED',
 'PACKPROOF_CSV_HEADER_VARIANTS_ENABLED']);
const shadow='PACKPROOF_SHIPMENT_INTERPRETATION_SHADOW_SOURCES';
const profiles={
 'packproof.connect-runtime-review/v7':{version:'v7',inventory:shipmentMigrationInventorySha256,records:shipmentRecordsInventorySha256,
  validate:validateReconstructionReview,pair:inspectShipmentAutomationPair,reader:'shipment-rollback-reader-probe.mjs',readerSchema:'packproof.shipment-rollback-reader/v1'},
 'packproof.connect-runtime-review/v8':{version:'v8',inventory:backfillMigrationInventorySha256,records:backfillRecordsInventorySha256,
  validate:validateBackfillReview,pair:inspectBackfillAutomationPair,reader:'backfill-rollback-reader-probe.mjs',readerSchema:'packproof.backfill-rollback-reader/v1'},
 'packproof.connect-runtime-review/v9':{version:'v9',inventory:backfillMigrationInventorySha256,records:backfillRecordsInventorySha256,
  validate:validateHostedReview,pair:inspectHostedBackfillAutomationPair,reader:'backfill-rollback-reader-probe.mjs',readerSchema:'packproof.backfill-rollback-reader/v1'},
};
export const shipmentRelease=r=>Object.hasOwn(profiles,r?.schema);
export const shipmentReleaseInventory=r=>profiles[r.schema].inventory;
function reviewEnv(version){
 const base='PACKPROOF_RECONSTRUCTION_'+version.toUpperCase()+'_REVIEW';
 return {reviewJson:base+'_JSON',reviewHash:base+'_SHA256'};
}
export function verifyShipmentDeploymentReview(snapshot,r,now){
 const v=r.preflightReview,profile=profiles[r.schema];
 const {reviewJson,reviewHash}=reviewEnv(profile.version);
 profile.validate(v,reconstructionDigest(v),r.sourceSha,new Date(now));
 check(v.inventorySha256===r.inventorySha256&&v.recordsMigrationSha256===profile.records&&
  v.candidateImage===r.image&&v.clusterArn===r.probeClusterArn&&v.apiRole===r.apiRole&&v.workerRole===r.workerRole&&
  v.target.host===r.database.host&&v.target.database===r.database.name&&Date.parse(v.expiresAt)>=Date.parse(r.expiresAt),
  'SHIPMENT_DEPLOYMENT_REVIEW_BINDING_MISMATCH');
 const policy=v.automationPolicy;
 check((profile.version==='v7'||v.backfillJobsEnabled===false)&&!policy.interpretationEnabled&&!policy.headerVariantsEnabled&&policy.shadowSourcesSha256===reconstructionDigest([]),
  'SHIPMENT_DEFAULT_OFF_REVIEW_REQUIRED');
 const containers=[snapshot.api.express.activeConfigurations[0].primaryContainer,
  ...snapshot.api.taskDefinition.containerDefinitions,...snapshot.worker.taskDefinition.containerDefinitions];
 for(const c of containers){
  check(!c.environmentFiles?.length&&!(c.secrets??[]).some(x=>offSwitches.has(x.name)||[shadow,reviewJson,reviewHash].includes(x.name)),
   'SHIPMENT_OPAQUE_POLICY_FORBIDDEN');
  for(const {name,value} of c.environment??[]){
   if(offSwitches.has(name))check(value==='false'||value==='','SHIPMENT_DEFAULT_OFF_REQUIRED');
   if(name===shadow)check(value==='','SHIPMENT_DEFAULT_OFF_REQUIRED');
   check(name!==reviewJson&&name!==reviewHash,'SHIPMENT_PROBE_BINDING_EXISTS');
  }
 }
}
export function configureShipmentProbe(c,r,kind,reader,script){
 const profile=profiles[r.schema],{reviewJson,reviewHash}=reviewEnv(profile.version);
 if(!reader){
  c.environment.push({name:reviewJson,value:JSON.stringify(r.preflightReview)},
   {name:reviewHash,value:reconstructionDigest(r.preflightReview)});
  c.command=['node',`/release/reconstruction-${profile.version}-runtime-preflight.mjs`,kind];
  return;
 }
 const readerSource=readFileSync(new URL(profile.reader,import.meta.url),'utf8');
 check(script?.reader===readerSource,'SHIPMENT_READER_PROBE_CODE_REQUIRED');
 const previous=kind==='api'?r.expectedApi:r.expectedWorker;
 const details={kind,sourceSha:previous.sourceSha,image:previous.image,apiRole:r.apiRole,workerRole:r.workerRole,
  database:r.database,environment:r.environment,clusterArn:r.probeClusterArn,inventorySha256:r.inventorySha256,
  reviewSha256:reconstructionDigest(r.preflightReview)};
 const encoded=gzipSync(readerSource).toString('base64');
 const bootstrap=`import {gunzipSync} from 'node:zlib';
process.argv=${JSON.stringify(['node','/tmp/shipment-reader.mjs',JSON.stringify(details)])};
const source=gunzipSync(Buffer.from('${encoded}','base64')).toString('base64');
const probe=await import('data:text/javascript;base64,'+source);
await probe.runRollbackReaderProbe();`;
 c.command=['node','--input-type=module','-e',bootstrap];
}
export function verifyShipmentProbeReports(r,probes,now){
 const profile=profiles[r.schema];
 const paired=profile.pair(r.preflightReview,probes.api.report,probes.worker.report,new Date(now));
 const taskArns=new Set();
 for(const kind of ['api','worker']){
  const candidate=probes[kind].report,reader=probes['previous-'+kind].report,prev=kind==='api'?r.expectedApi:r.expectedWorker;
  check(candidate.automationPolicy.interpretationEnabled===false&&candidate.automationPolicy.headerVariantsEnabled===false&&
   candidate.automationPolicy.shadowSourceCount===0&&candidate.automationPolicy.shadowSourcesSha256===reconstructionDigest([]),
   'SHIPMENT_DEFAULT_OFF_RECEIPTS_REQUIRED');
  const elapsed=now-Date.parse(reader?.completedAt);
  check(reader?.schema===profile.readerSchema&&reader.kind===kind&&reader.sourceSha===prev.sourceSha&&
   reader.image===prev.image&&reader.environment===r.environment&&reader.inventorySha256===r.inventorySha256&&
   reader.readOnly===true&&reader.compatibleReader===true&&reader.reviewSha256===paired.reviewSha256&&
   reader.role===(kind==='api'?r.apiRole:r.workerRole)&&reader.databaseHost===r.database.host&&reader.databaseName===r.database.name&&
   reader.clusterArn===r.probeClusterArn&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=900000,'SHIPMENT_COMPATIBLE_PREDECESSOR_REQUIRED');
  taskArns.add(candidate.taskIdentity.taskArn);taskArns.add(reader.taskArn);
 }
 check(taskArns.size===4,'SHIPMENT_DISTINCT_TASKS_REQUIRED');
 return paired;
}
