// Constructs the one reviewed foundation-to-inactive-M2 bridge request. No AWS writes.
// Neither the original foundation operator nor the application feature gates are widened.
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {createHash} from 'node:crypto';
export const M2_BRIDGE=Object.freeze({
 previousSource:'99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9',
 previousImage:TARGET.repository+'@sha256:bfe92a04ea17de5b44bf3e7c7d34929669b40ef903d14f81d3be33cfef6362a2',
 source:'399f306a2fdac37511c8659c73d5a059dd759b7a',
 image:TARGET.repository+'@sha256:434f5cd40bf365a6bdf585fa6302f786ea4571dda892fd761c3dbd85d6b5aa54',
 harness:'cb2f55a7ebe398ab35fcc77ee9337b46c1bf7c9d',
 baseline:'4c8fdf8c9a1c08b22c1b13ddd54dc34c7e51cdd3a1dc238edb5485a7a970556e',
});
const releases=['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'];
const overlayPaths=['.gitleaksignore','backend/scripts/m2-bridge-compatibility-acceptance.mjs','web/src/tests/app.test.tsx'];
const check=(ok,code)=>{if(!ok)throw Error(code);};
const fresh=(value,now,limit)=>{const age=now.getTime()-Date.parse(value);return age>=0&&age<=limit;};
export function m2BridgeDeploymentPlan(snapshot,candidate,now=new Date()){
 const {service,express,meta}=snapshot;
 check(snapshot.account===TARGET.account&&snapshot.region===TARGET.region&&service?.serviceArn===TARGET.serviceArn&&express?.serviceArn===TARGET.serviceArn,'TARGET_MISMATCH');
 check(fresh(snapshot.observedAt,now,300000),'STALE_DEPLOYMENT_SNAPSHOT');
 check(service.status==='ACTIVE'&&service.desiredCount>=1&&service.runningCount===service.desiredCount&&service.pendingCount===0&&snapshot.nativeDeploymentStatus==='SUCCESSFUL','PREDECESSOR_NOT_STABLE');
 check(express.activeConfigurations?.length===1,'AMBIGUOUS_CONFIGURATION');
 const config=express.activeConfigurations[0],original=config.primaryContainer;
 check(config.taskDefinitionArn===service.taskDefinition,'TASK_REVISION_MISMATCH');
 const bindings=[...(original.environment??[]),...(original.secrets??[])],names=bindings.map(e=>e.name);
 check(names.length===new Set(names).size,'DUPLICATE_BINDINGS');
 const env=Object.fromEntries((original.environment??[]).map(e=>[e.name,e.value]));
 check(env.PACKPROOF_ENVIRONMENT==='production'&&env.PACKPROOF_MIGRATE_ON_START==='false','UNACTIVATED_PRODUCTION_REQUIRED');
 for(const name of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_CLAIM_EXPORTS_ENABLED'])check(env[name]===undefined||env[name]==='false','ACTIVATION_NOT_ALLOWED');
 check(env.PACKPROOF_REQUIRE_DURABLE_RECEIPTS==='false'&&(!env.PACKPROOF_PROCESS_ROLE||env.PACKPROOF_PROCESS_ROLE==='combined'),'UNREVIEWED_TOPOLOGY_CHANGE');
 check(env.PACKPROOF_S3_BUCKET==='packproof-v2-evidence-staging-20260829-a7f3'&&(!env.PACKPROOF_COMMITTED_S3_BUCKET||env.PACKPROOF_COMMITTED_S3_BUCKET===env.PACKPROOF_S3_BUCKET),'ORIGINAL_OBJECT_BUCKET_REQUIRED');
 check(meta?.commit===M2_BRIDGE.previousSource&&meta.image===M2_BRIDGE.previousImage&&original.image===meta.image&&env.PACKPROOF_RELEASE_SHA===meta.commit&&env.PACKPROOF_RELEASE_IMAGE===meta.image&&env.PACKPROOF_RELEASE_VERSION===meta.version,'PUBLIC_RUNTIME_IDENTITY_MISMATCH');
 check(candidate.source===M2_BRIDGE.source&&candidate.image===M2_BRIDGE.image,'SOURCE_TRANSITION_NOT_REVIEWED');
 check(candidate.expectedPreviousRevision===config.serviceRevisionArn&&candidate.expectedPreviousImage===original.image,'PREDECESSOR_CHANGED');
 check(/^[A-Za-z0-9._-]{1,100}$/.test(candidate.version),'INVALID_VERSION');
 check(candidate.build?.status==='SUCCEEDED'&&candidate.build.source===M2_BRIDGE.source&&candidate.build.image===M2_BRIDGE.image,'BUILD_RECEIPT_REQUIRED');
 check(candidate.scan?.status==='COMPLETE'&&candidate.scan.image===M2_BRIDGE.image&&Object.values(candidate.scan.findings??{}).every(n=>n===0),'CLEAN_IMAGE_SCAN_REQUIRED');
 const p=candidate.preflight;
 check(p?.status==='PASSED'&&p.source===M2_BRIDGE.source&&p.image===M2_BRIDGE.image&&fresh(p.observedAt,now,900000),'FRESH_IMAGE_PREFLIGHT_REQUIRED');
 check(p.identity?.role==='packproof_app_runtime_v1'&&p.identity.login===p.identity.role&&p.identity.database==='packproof_v2'&&p.identity.read_only==='on'&&p.tls?.ssl===true&&p.runtimeAuthoritySafe===true,'READ_ONLY_NON_OWNER_REQUIRED');
 check(p.organizationCount===0&&p.inFlightRecipientJobs===0&&p.durabilityPolicyMatches===true&&p.exactVersionsVerified===p.committedEvidenceCount&&p.signedVerified+p.legacyUnsigned===p.manifestCount,'PRESERVATION_PREFLIGHT_REQUIRED');
 check(p.sourceMigrationCount===91&&p.applied?.length===91,'BRIDGE_MUST_PRECEDE_MIGRATION');
 const inventory=p.applied.map(({id,checksum})=>({id,checksum})).sort((a,b)=>a.id.localeCompare(b.id));
 check(createHash('sha256').update(JSON.stringify(inventory)).digest('hex')===M2_BRIDGE.baseline,'BASELINE_DIGEST_REQUIRED');
 const compatibility=candidate.compatibility,receipts=compatibility?.receipts??[];
 check(compatibility?.status==='PASSED'&&compatibility.cleanup?.status==='PASSED'&&['containerRemoved','fixtureVolumeRemoved','networkRemoved'].every(k=>compatibility.cleanup[k]===true),'COMPATIBILITY_CLEANUP_REQUIRED');
 check(receipts.length===4&&['bootstrap','before','migrate','after'].every(mode=>receipts.filter(r=>r.mode===mode).length===1),'COMPATIBILITY_MODES_REQUIRED');
 check(receipts.every(r=>r.status==='PASSED'&&r.source===M2_BRIDGE.source&&r.harness===M2_BRIDGE.harness&&r.image===M2_BRIDGE.image&&r.syntheticOnly===true&&r.productionChanged===false),'COMPILED_COMPATIBILITY_REQUIRED');
 const after=receipts.find(r=>r.mode==='after');
 check(['pre_migration_approved_download_is_byte_identical','new_m2_tables_remain_unreadable_to_bridge','accepted_terminal_row_cannot_change'].every(k=>after.checks.includes(k)),'ROLLBACK_BOUNDARY_PROOF_REQUIRED');
 const ci=candidate.ci;
 check(ci?.backend?.source===M2_BRIDGE.source&&ci.backend.status==='PASSED'&&ci.postgres?.source===M2_BRIDGE.source&&ci.postgres.status==='PASSED','EXACT_RUNTIME_CI_REQUIRED');
 check(ci.overlay?.base===M2_BRIDGE.source&&ci.overlay.head===M2_BRIDGE.harness&&hash([...ci.overlay.changedPaths].sort())===hash([...overlayPaths].sort()),'UNREVIEWED_TEST_OVERLAY');
 check(['web','sourceSecurity'].every(k=>ci[k]?.source===M2_BRIDGE.harness&&ci[k].status==='PASSED'),'REMAINING_CI_REQUIRED');
 const policy=service.deploymentConfiguration;
 check(policy?.strategy==='CANARY'&&policy.canaryConfiguration?.canaryPercent===5&&policy.canaryConfiguration?.canaryBakeTimeInMinutes===3&&policy.bakeTimeInMinutes===3&&policy.minimumHealthyPercent===100&&policy.maximumPercent===200&&policy.deploymentCircuitBreaker?.enable&&policy.deploymentCircuitBreaker?.rollback&&policy.alarms?.enable&&policy.alarms?.rollback&&policy.alarms.alarmNames?.length>0,'CANARY_AND_ROLLBACK_REQUIRED');
 const next=structuredClone(original),values={PACKPROOF_RELEASE_SHA:candidate.source,PACKPROOF_RELEASE_IMAGE:candidate.image,PACKPROOF_RELEASE_VERSION:candidate.version};
 check(releases.every(name=>Object.hasOwn(env,name)),'RELEASE_BINDINGS_MISSING');
 next.image=candidate.image;next.environment=next.environment.map(e=>Object.hasOwn(values,e.name)?{...e,value:values[e.name]}:e);
 const preserved=c=>({...c,image:undefined,environment:c.environment.filter(e=>!releases.includes(e.name))});
 check(hash(preserved(next))===hash(preserved(original)),'RUNTIME_CONFIGURATION_CHANGED');
 return {update:{serviceArn:TARGET.serviceArn,primaryContainer:next},rollback:{serviceArn:TARGET.serviceArn,primaryContainer:structuredClone(original)},summary:{
  source:candidate.source,image:candidate.image,previousSource:meta.commit,previousImage:meta.image,previousRevision:config.serviceRevisionArn,
  snapshotSha256:hash(snapshot),preservedContainerSha256:hash(preserved(original)),deploymentPolicySha256:hash(policy),candidateEvidenceSha256:hash(candidate),desiredCount:service.desiredCount,
  permittedChanges:['primaryContainer.image',...releases],schemaMutation:false,organizationActivation:false,
  rollbackBoundary:'The predecessor rollback request is valid only before 093-095. After migration, retain this exact bridge only while all M2 tables remain empty and inaccessible to runtime roles. Retire the old login before activation.'}};
}
