// Explicit, frozen inactive transition. The generic release planner is unchanged.
import {TARGET,hash} from './backend-deployment-plan.mjs';
export const SOURCE='65700aac0d8d3d0640b13469a2d508d86efcc318';
export const BRIDGE=TARGET.repository+'@sha256:4302f878d198b082dee8866355b8dcfde7ce9eea37461503242c6c04ee3f6f06';
export const APPLICATION=TARGET.repository+'@sha256:6a396f672e62636a6fb603b7e922afadeed0070183d319e3ef335e9ac4274d6f';
export const PREDECESSOR='arn:aws:ecs:us-east-1:784514617543:task-definition/packproof-v2-staging-cluster-packproof-v2-staging-api:50';
const names=['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'];
const fail=code=>{throw Error(code);};
export function inactiveApplicationPlan(snapshot,qualification){
 const {service,express,meta}=snapshot??{},configs=express?.activeConfigurations;
 if(snapshot?.account!==TARGET.account||snapshot.region!==TARGET.region||service?.serviceArn!==TARGET.serviceArn||express?.serviceArn!==TARGET.serviceArn)fail('INACTIVE_TARGET_MISMATCH');
 if(service.status!=='ACTIVE'||service.taskDefinition!==PREDECESSOR||snapshot.nativeDeploymentStatus!=='SUCCESSFUL'||service.desiredCount!==1||service.runningCount!==1||service.pendingCount!==0||configs?.length!==1)fail('INACTIVE_PREDECESSOR_NOT_STABLE');
 const original=configs[0].primaryContainer,all=[...(original?.environment??[]),...(original?.secrets??[])],env=Object.fromEntries((original?.environment??[]).map(x=>[x.name,x.value]));
 if(all.some(x=>typeof x.name!=='string')||new Set(all.map(x=>x.name)).size!==all.length||original?.image!==BRIDGE||meta?.image!==BRIDGE||meta.commit!==SOURCE||env.PACKPROOF_RELEASE_SHA!==SOURCE||env.PACKPROOF_RELEASE_IMAGE!==BRIDGE||env.PACKPROOF_RELEASE_VERSION!==meta.version)fail('INACTIVE_PREDECESSOR_IDENTITY_MISMATCH');
 if(env.PACKPROOF_ENVIRONMENT!=='production'||env.PACKPROOF_MIGRATE_ON_START!=='false'||!env.PACKPROOF_WEB_ORIGINS||!env.PACKPROOF_PUBLIC_URL||names.some(n=>!Object.hasOwn(env,n)))fail('INACTIVE_CONFIGURATION_REQUIRED');
 for(const flag of ['PACKPROOF_ORGANIZATIONS_ENABLED','PACKPROOF_CLAIM_EXPORTS_ENABLED','PACKPROOF_REQUIRE_DURABLE_RECEIPTS'])if(env[flag]!==undefined&&env[flag]!=='false')fail('INACTIVE_FEATURE_ACTIVATION_FORBIDDEN');
 const q=qualification?.receipt;
 if(qualification?.taskStopped!==true||qualification.exitCode!==0||qualification.actualImage!==APPLICATION||qualification.ciPassed!==true||qualification.sourceArchiveVerified!==true||q?.event!=='records_inactive_app_preflight'||q.source!==SOURCE||q.image!==APPLICATION||q.processRole!=='api'||q.databaseReadOnly!==true||q.workersStarted!==false||q.featuresActivated!==false)fail('INACTIVE_QUALIFICATION_REQUIRED');
 if(q.identity?.role!=='packproof_app_runtime_v1'||q.identity.login!==q.identity.role||q.identity.database!=='packproof_v2'||q.identity.schema!=='public'||q.identity.default_read_only!=='on'||q.tls?.ssl!==true||q.migrationCount!==106||q.migrationSha256!=='605ba38f1c9ffcd6dd28a64a7d07d9cc41c3397ee7c10ba26198ad14ec50c2e1')fail('INACTIVE_DATABASE_QUALIFICATION_MISMATCH');
 const routes=['/meta','/health','/ready'];
 if(q.checks?.length!==3||routes.some(route=>q.checks.filter(c=>c.route===route&&c.status===200&&c.cors==='https://thepackproof.com').length!==1))fail('INACTIVE_HTTP_QUALIFICATION_MISMATCH');
 const next=structuredClone(original);next.image=APPLICATION;
 const changes={PACKPROOF_RELEASE_SHA:SOURCE,PACKPROOF_RELEASE_IMAGE:APPLICATION,PACKPROOF_RELEASE_VERSION:'records-inactive-2026.11.05-65700aac'};
 next.environment=next.environment.map(x=>Object.hasOwn(changes,x.name)?{...x,value:changes[x.name]}:x);
 const preserve=c=>({...c,image:undefined,environment:c.environment.filter(x=>!names.includes(x.name))});
 if(hash(preserve(next))!==hash(preserve(original)))fail('INACTIVE_CONTAINER_DRIFT');
 return {update:{serviceArn:TARGET.serviceArn,primaryContainer:next},rollback:{serviceArn:TARGET.serviceArn,primaryContainer:structuredClone(original)},summary:{profile:'records-inactive-application/v1',source:SOURCE,image:APPLICATION,previousImage:BRIDGE,previousTaskDefinition:PREDECESSOR,qualifiedByReadOnlyStartup:true,recordsActivationQualified:false,preservedPrimaryContainerSha256:hash(preserve(original)),permittedChanges:['primaryContainer.image',...names.map(n=>'primaryContainer.environment.'+n)]}};
}
