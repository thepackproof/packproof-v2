// Exact-source, unactivated foundation rollout. This constructs requests only.
// The old measurement operator retains its original, narrower release boundary.
import {TARGET,hash} from './backend-deployment-plan.mjs';
export const FOUNDATION_SOURCES=Object.freeze({previous:'ccd04aba5b9305ce9bb7b2105323e63f6a95d87a',bridge:'6bd6f74a89f01fcacecc06f888a8245d7927ddb9',candidate:'99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9'});
const releaseNames=['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'];
const check=(ok,code)=>{if(!ok)throw Error(code);};
const immutable=image=>typeof image==='string'&&image.startsWith(TARGET.repository+'@sha256:')&&/^[a-f0-9]{64}$/.test(image.slice((TARGET.repository+'@sha256:').length));
export function foundationDeploymentPlan(snapshot,candidate,now=new Date()){
 const {service,express,meta,nativeDeploymentStatus}=snapshot;
 check(snapshot.account===TARGET.account&&snapshot.region===TARGET.region&&service?.serviceArn===TARGET.serviceArn&&express?.serviceArn===TARGET.serviceArn,'TARGET_MISMATCH');
 const age=now.getTime()-Date.parse(snapshot.observedAt);check(age>=0&&age<=300000,'STALE_DEPLOYMENT_SNAPSHOT');
 check(service.status==='ACTIVE'&&service.desiredCount>=1&&service.runningCount===service.desiredCount&&service.pendingCount===0&&nativeDeploymentStatus==='SUCCESSFUL','PREDECESSOR_NOT_STABLE');
 check(express.activeConfigurations?.length===1,'AMBIGUOUS_CONFIGURATION');
 const config=express.activeConfigurations[0],original=config.primaryContainer;
 check(config.taskDefinitionArn===service.taskDefinition,'TASK_REVISION_MISMATCH');
 const names=[...(original.environment??[]),...(original.secrets??[])].map(x=>x.name);
 check(names.length===new Set(names).size,'DUPLICATE_BINDINGS');
 const env=Object.fromEntries((original.environment??[]).map(x=>[x.name,x.value]));
 check(env.PACKPROOF_ENVIRONMENT==='production'&&env.PACKPROOF_MIGRATE_ON_START==='false'&&env.PACKPROOF_ORGANIZATIONS_ENABLED!=='true','UNACTIVATED_PRODUCTION_REQUIRED');
 check(env.PACKPROOF_REQUIRE_DURABLE_RECEIPTS==='false'&&(!env.PACKPROOF_PROCESS_ROLE||env.PACKPROOF_PROCESS_ROLE==='combined'),'UNREVIEWED_TOPOLOGY_CHANGE');
 check(env.PACKPROOF_S3_BUCKET==='packproof-v2-evidence-staging-20260829-a7f3'&&(!env.PACKPROOF_COMMITTED_S3_BUCKET||env.PACKPROOF_COMMITTED_S3_BUCKET===env.PACKPROOF_S3_BUCKET),'ORIGINAL_OBJECT_BUCKET_REQUIRED');
 check(meta?.commit===env.PACKPROOF_RELEASE_SHA&&meta.image===env.PACKPROOF_RELEASE_IMAGE&&meta.version===env.PACKPROOF_RELEASE_VERSION&&meta.image===original.image,'PUBLIC_RUNTIME_IDENTITY_MISMATCH');
 const stage=candidate.stage,expectedPrevious=stage==='bridge'?FOUNDATION_SOURCES.previous:FOUNDATION_SOURCES.bridge;
 check(['bridge','candidate'].includes(stage)&&candidate.sourceSha===FOUNDATION_SOURCES[stage]&&meta.commit===expectedPrevious,'SOURCE_TRANSITION_NOT_REVIEWED');
 check(immutable(original.image)&&immutable(candidate.image)&&original.image!==candidate.image,'IMMUTABLE_IMAGE_REQUIRED');
 check(candidate.expectedPreviousRevision===config.serviceRevisionArn&&candidate.expectedPreviousImage===original.image,'PREDECESSOR_CHANGED');
 check(/^[A-Za-z0-9._-]{1,100}$/.test(candidate.version),'INVALID_VERSION');
 check(candidate.build?.status==='SUCCEEDED'&&candidate.build.source===candidate.sourceSha&&candidate.build.image===candidate.image,'BUILD_RECEIPT_REQUIRED');
 check(candidate.scan?.status==='COMPLETE'&&candidate.scan.image===candidate.image&&Object.values(candidate.scan.findings??{}).every(n=>n===0),'CLEAN_IMAGE_SCAN_REQUIRED');
 const p=candidate.preflight;
 const preflightAge=now.getTime()-Date.parse(p?.observedAt);
 check(p?.status==='PASSED'&&p.source===candidate.sourceSha&&p.image===candidate.image&&preflightAge>=0&&preflightAge<=900000,'FRESH_IMAGE_PREFLIGHT_REQUIRED');
 check(p.runtimeAuthorityUnchanged===true&&p.durabilityPolicyMatches===true&&p.organizationCount===0&&p.exactVersionsVerified===p.committedEvidenceCount&&p.signedVerified+p.legacyUnsigned===p.manifestCount,'PRESERVATION_PREFLIGHT_REQUIRED');
 check(p.applied?.length===(stage==='bridge'?86:91)&&p.sourceMigrationCount===(stage==='bridge'?86:91),'MIGRATION_BOUNDARY_MISMATCH');
 check(candidate.compatibility?.status==='PASSED'&&candidate.compatibility.bridgeSource===FOUNDATION_SOURCES.bridge&&candidate.compatibility.candidateSource===FOUNDATION_SOURCES.candidate&&candidate.compatibility.rejectsActivation===true,'ROLLBACK_BRIDGE_PROOF_REQUIRED');
 check(stage==='bridge'||candidate.ci?.source===candidate.sourceSha&&candidate.ci?.status==='PASSED','EXACT_CANDIDATE_CI_REQUIRED');
 const policy=service.deploymentConfiguration;
 check(policy?.strategy==='CANARY'&&policy.canaryConfiguration?.canaryPercent===5&&policy.canaryConfiguration?.canaryBakeTimeInMinutes===3&&policy.bakeTimeInMinutes===3&&policy.minimumHealthyPercent===100&&policy.maximumPercent===200&&policy.deploymentCircuitBreaker?.enable&&policy.deploymentCircuitBreaker?.rollback&&policy.alarms?.enable&&policy.alarms?.rollback,'CANARY_AND_ROLLBACK_REQUIRED');
 const next=structuredClone(original),releases={PACKPROOF_RELEASE_SHA:candidate.sourceSha,PACKPROOF_RELEASE_IMAGE:candidate.image,PACKPROOF_RELEASE_VERSION:candidate.version};
 check(releaseNames.every(name=>Object.hasOwn(env,name)),'RELEASE_BINDINGS_MISSING');
 next.image=candidate.image;next.environment=next.environment.map(x=>Object.hasOwn(releases,x.name)?{...x,value:releases[x.name]}:x);
 const preserved=c=>({...c,image:undefined,environment:c.environment.filter(x=>!releaseNames.includes(x.name))});
 check(hash(preserved(next))===hash(preserved(original)),'RUNTIME_CONFIGURATION_CHANGED');
 return {update:{serviceArn:TARGET.serviceArn,primaryContainer:next},rollback:{serviceArn:TARGET.serviceArn,primaryContainer:structuredClone(original)},
  summary:{stage,source:candidate.sourceSha,image:candidate.image,previousSource:meta.commit,previousImage:meta.image,previousRevision:config.serviceRevisionArn,
   snapshotSha256:hash(snapshot),preservedContainerSha256:hash(preserved(original)),deploymentPolicySha256:hash(policy),desiredCount:service.desiredCount,
   permittedChanges:['primaryContainer.image',...releaseNames],organizationActivation:false,
   rollbackBoundary:'Bridge is valid only while platform_organizations remains empty. Do not activate organizations with this fallback.'}};
}
