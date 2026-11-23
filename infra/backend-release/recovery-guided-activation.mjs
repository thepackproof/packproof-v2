// Separate, exact-facility configuration operation. Image release gates stay unchanged.
import {createHash} from 'node:crypto';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {sessionPolicy} from './backend-release-session-policies.mjs';
import {verifyService} from './connect-hosted-owner-task.mjs';
import {normalizeRecoverySnapshot,verifyRecoveryTaskRegistration} from './recovery-runtime-release.mjs';
import {releasePins,verifyReleasePins,recoverySessionPolicy} from './recovery-hosted-release.mjs';
import {validateFacilityRecipientKey} from './logistics-facility-inspect.mjs';

export const guidedName='PACKPROOF_GUIDED_FACILITIES';
export const guidedInventory='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
const aiName='PACKPROOF_SETUP_AI_FACILITIES';
const check=(ok,code)=>{if(!ok)throw Error('GUIDED_ACTIVATION_'+code);};
const sha=(s,n=64)=>typeof s==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(s);
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const fresh=(at,now,age=300000)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&now-Date.parse(at)<=age;
const cloneWithout=(value,names)=>Object.fromEntries(Object.entries(structuredClone(value)).filter(([name])=>!names.includes(name)));
const responseFields=['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'];
const taskArn=value=>new RegExp('^arn:aws:ecs:'+TARGET.region+':'+TARGET.account+':task-definition/packproof-[A-Za-z0-9_-]+:[1-9][0-9]*$').test(value??'');
const image=value=>typeof value==='string'&&value.startsWith(TARGET.repository+'@sha256:')&&sha(value.split('@sha256:')[1]);
const rawDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateGuidedRequest(request,now=Date.now()) {
  check(keys(request,['schema','operation','source','build','expected','facility','expiresAt',...(request?.operation==='rollback'?['rollback']:[])]),'REQUEST_FIELDS');
  check(request.schema==='packproof.guided-activation-request/v1'&&['activate','rollback'].includes(request.operation)&&sha(request.source,40),'REQUEST');
  const b=request.build;
  check(keys(b,['source','archiveSha256','sourceVersion','buildId','ciRunId','candidate','fallback','predecessor'])&&sha(b.source,40)&&sha(b.archiveSha256)&&
    typeof b.sourceVersion==='string'&&b.sourceVersion.length>0&&b.sourceVersion.length<=256&&b.sourceVersion!=='null'&&
    /^packproof-v2-staging-api:[a-f0-9-]{36}$/.test(b.buildId??'')&&Number.isSafeInteger(b.ciRunId)&&b.ciRunId>0&&
    [b.candidate,b.fallback,b.predecessor].every(image)&&new Set([b.candidate,b.fallback,b.predecessor]).size===3,'BUILD_PINS');
  check(keys(request.expected,['api','worker','topologySha256','preservationSha256'])&&sha(request.expected.topologySha256)&&sha(request.expected.preservationSha256)&&
    ['api','worker'].every(k=>keys(request.expected[k],['source','image','taskDefinition'])&&request.expected[k].source===b.source&&
      request.expected[k].image===b.candidate&&taskArn(request.expected[k].taskDefinition)),'POST_CANDIDATE_PINS');
  const f=request.facility;
  check(keys(f,['subjectSha256','selectionSha256','scopeSha256','recipientPublicKeySpki'])&&
    [f.subjectSha256,f.selectionSha256,f.scopeSha256].every(v=>sha(v)),'FACILITY_HASHES');
  validateFacilityRecipientKey(f.recipientPublicKeySpki);
  check(Date.parse(request.expiresAt)>now&&Date.parse(request.expiresAt)-now<=7200000,'REQUEST_EXPIRED');
  if(request.operation==='rollback')check(keys(request.rollback,['previousApiTaskDefinition','previousPrimaryContainerSha256','activatedPrimaryContainerSha256'])&&
    taskArn(request.rollback.previousApiTaskDefinition)&&sha(request.rollback.previousPrimaryContainerSha256)&&sha(request.rollback.activatedPrimaryContainerSha256),'ROLLBACK_PINS');
  return request;
}

function scope(row) {
  check(['organization_id','location_id'].every(k=>typeof row?.[k]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(row[k]))&&
    ['sandbox','live'].includes(row.environment),'BOUND_SCOPE');
  return [row.organization_id,row.environment,row.location_id];
}
export const guidedScopeDigest=row=>rawDigest(['packproof.guided-scope/v1',...scope(row)]);
export function guidedSelectionDigest(row,subjectSha256) {
  check(sha(subjectSha256)&&typeof row?.installation_id==='string'&&/^installation_[A-Za-z0-9]{1,80}$/.test(row.installation_id),'INSTALLATION_SELECTION');
  return rawDigest(['packproof.guided-selection/v1',subjectSha256,row.installation_id,...scope(row)]);
}
export function selectBoundGuidedFacility(report,request,now=Date.now()) {
  check(report?.schema==='packproof.logistics-facility-inspection/v1'&&report.readOnly===true&&report.rolledBack===true&&
    report.inventorySha256===guidedInventory&&report.source===request.build.source&&report.image===request.build.candidate&&
    fresh(report.completedAt,now)&&report.truncated===false&&Array.isArray(report.installations)&&
    report.totalMatchingInstallations===report.installations.length,'FRESH_PRIVATE_INSPECTION');
  const matches=report.installations.filter(row=>row.location_id&&
    guidedSelectionDigest(row,request.facility.subjectSha256)===request.facility.selectionSha256&&guidedScopeDigest(row)===request.facility.scopeSha256);
  check(matches.length===1,'EXACT_BOUND_SELECTION');
  const row=matches[0];
  check(['OWNER','ADMIN'].includes(row.actor_role)&&row.organization_enabled===true&&row.actor_location_allowed===true&&
    row.location_exists===true&&row.enrollment_acknowledged===true&&row.renewal_pending===false&&
    ['setup','ready','active'].includes(row.status)&&row.eligibleLocationsTruncated===false&&Array.isArray(row.eligibleLocations)&&
    row.totalEligibleLocations===row.eligibleLocations.length&&row.eligibleLocations.filter(value=>value.id===row.location_id).length===1,'CURRENT_HUMAN_AND_OPERATOR');
  // eligibleLocations is the fixed inspector's intersection of current human and
  // active enrolled-operator grants. An unbound installation is never selected.
  return row;
}

function environment(container) {
  const pairs=[...(container.environment??[]),...(container.secrets??[])];
  check(pairs.every(x=>typeof x.name==='string')&&new Set(pairs.map(x=>x.name)).size===pairs.length&&!container.environmentFiles?.length,'AMBIGUOUS_ENVIRONMENT');
  check(!(container.secrets??[]).some(x=>[guidedName,aiName].includes(x.name)),'OPAQUE_FACILITY_FLAGS');
  check((container.environment??[]).every(x=>typeof x.value==='string'),'ENVIRONMENT_VALUE');
  return Object.fromEntries((container.environment??[]).map(x=>[x.name,x.value]));
}
function primary(snapshot,kind) {
  const list=snapshot[kind].taskDefinition.containerDefinitions.filter(c=>environment(c).PACKPROOF_PROCESS_ROLE===kind);
  check(list.length===1,'PRIMARY_CONTAINER');return list[0];
}
function orderedContainer(container,omitGuided=false) {
  environment(container);const value=structuredClone(container);
  if(value.environment)value.environment=value.environment.filter(x=>!omitGuided||x.name!==guidedName).sort((a,b)=>a.name.localeCompare(b.name));
  if(value.secrets)value.secrets.sort((a,b)=>a.name.localeCompare(b.name));
  return value;
}
function taskShape(task,omitGuided=false) {
  const copy=cloneWithout(task,responseFields);
  copy.containerDefinitions=copy.containerDefinitions.map(c=>orderedContainer(c,omitGuided));
  return copy;
}
function serviceShape(service) {
  return cloneWithout(service,['taskDefinition','deployments','currentServiceRevisions','events','runningCount','pendingCount']);
}
export function guidedPreservationHash(snapshot) {
  const s=normalizeRecoverySnapshot(snapshot),config=s.api.express.activeConfigurations[0];
  const express=cloneWithout(s.api.express,['activeConfigurations','updatedAt']);
  const fixed=cloneWithout(config,['primaryContainer','serviceRevisionArn','taskDefinitionArn','createdAt']);
  return hash({express,fixed,apiContainer:orderedContainer(config.primaryContainer,true),apiTask:taskShape(s.api.taskDefinition,true),
    apiService:serviceShape(s.api.service),apiIdentity:s.api.meta,workerTask:s.worker.taskDefinition,
    workerService:serviceShape(s.worker.service),workerTaskDefinition:s.worker.service.taskDefinition,topology:s.topology,probe:s.probe});
}
export function verifyGuidedRuntime(snapshot,request,publication,now=Date.now()) {
  const s=normalizeRecoverySnapshot(snapshot);
  check(s.account===TARGET.account&&s.region===TARGET.region&&fresh(s.observedAt,now),'FRESH_RUNTIME');
  check(hash(publication)===hash(request.build),'ACTUAL_BUILD_PUBLICATION');
  for(const kind of ['api','worker'])verifyService(s[kind],kind,{source:publication.source,image:publication.candidate},false);
  check(s.api.taskDefinition.containerDefinitions.length===1,'API_CONTAINER_SHAPE');
  check(s.api.publicChecks?.['/health']===200&&s.api.publicChecks?.['/ready']===200&&s.api.publicChecks?.['/me/capabilities']===401,'PUBLIC_READINESS');
  const live=environment(s.api.express.activeConfigurations[0].primaryContainer),task=environment(primary(s,'api'));
  check(hash(live)===hash(task)&&hash(s.api.express.activeConfigurations[0].primaryContainer.secrets??[])===hash(primary(s,'api').secrets??[]),'EXPRESS_TASK_BINDINGS');
  check(live.PACKPROOF_ORDER_WORKSPACE_ENABLED==='true','ORDER_WORKSPACE_DISABLED');
  return s;
}
function allowlist(value) {
  if(value===undefined||value==='')return [];
  check(value.length<=16000,'ALLOWLIST_SIZE');
  const list=value.split(',').map(x=>x.trim());
  check(list.every(x=>/^[A-Za-z0-9_-]{1,128}:(sandbox|live):[A-Za-z0-9_-]{1,128}$/.test(x))&&new Set(list).size===list.length,'EXACT_ALLOWLIST');
  return list;
}
function setGuided(container,value) {
  const out=structuredClone(container),found=(out.environment??[]).some(x=>x.name===guidedName);
  out.environment=(out.environment??[]).flatMap(x=>x.name===guidedName?(value===undefined?[]:[{...x,value}]):[x]);
  if(!found&&value!==undefined)out.environment.push({name:guidedName,value});
  return out;
}
const append=(value,tuple)=>value?value+','+tuple:tuple;

export function createGuidedPlan({snapshot,request,publication,report,previousTaskDefinition},now=Date.now()) {
  validateGuidedRequest(request,now);
  const s=verifyGuidedRuntime(snapshot,request,publication,now);verifyReleasePins(s,request.expected);
  const row=selectBoundGuidedFacility(report,request,now),tuple=scope(row).join(':');
  const before=s.api.express.activeConfigurations[0].primaryContainer,values=environment(before),existing=allowlist(values[guidedName]);
  // Otherwise one guided change would indirectly enable the assistant too.
  check(!allowlist(values[aiName]).includes(tuple),'INDIRECT_ASSISTANT_ACTIVATION');
  let next=existing.includes(tuple)?values[guidedName]:append(values[guidedName],tuple);
  if(request.operation==='rollback') {
    const rollback=request.rollback;
    check(previousTaskDefinition?.taskDefinitionArn===rollback.previousApiTaskDefinition&&previousTaskDefinition.family===s.api.taskDefinition.family,'PREVIOUS_TASK');
    const old=previousTaskDefinition.containerDefinitions.filter(c=>environment(c).PACKPROOF_PROCESS_ROLE==='api');
    check(old.length===1,'PREVIOUS_PRIMARY');next=environment(old[0])[guidedName];
    check(!allowlist(next).includes(tuple)&&values[guidedName]===append(next,tuple)&&hash(before)===rollback.activatedPrimaryContainerSha256,'ROLLBACK_EXACT_APPEND');
    const reversed=structuredClone(s.api.taskDefinition);
    reversed.containerDefinitions=reversed.containerDefinitions.map(c=>environment(c).PACKPROOF_PROCESS_ROLE==='api'?setGuided(c,next):c);
    verifyRecoveryTaskRegistration(previousTaskDefinition,reversed);
    check(hash(setGuided(before,next))===rollback.previousPrimaryContainerSha256,'ROLLBACK_ORIGINAL_CONFIGURATION');
  }
  allowlist(next);
  const after=setGuided(before,next),changed=hash(before)!==hash(after);
  check(hash(orderedContainer(before,true))===hash(orderedContainer(after,true)),'ONLY_GUIDED_FLAG');
  const plan={schema:'packproof.guided-activation-plan/v1',operation:request.operation,source:request.source,runtimeSource:publication.source,
    image:publication.candidate,preparedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(Date.parse(request.expiresAt),Date.parse(report.completedAt)+300000)).toISOString(),
    selectionSha256:request.facility.selectionSha256,scopeSha256:request.facility.scopeSha256,changed,
    beforePins:releasePins(s),preservationSha256:guidedPreservationHash(s),previousApiTaskDefinition:s.api.taskDefinition.taskDefinitionArn,
    beforePrimaryContainerSha256:hash(before),afterPrimaryContainerSha256:hash(after),
    update:changed?{serviceArn:TARGET.serviceArn,primaryContainer:after}:null,
    rollback:changed?{serviceArn:TARGET.serviceArn,primaryContainer:structuredClone(before)}:null};
  return {...plan,planSha256:hash(plan)};
}
function validPlan(plan,now) {
  const {planSha256,...body}=plan??{};
  check(plan?.schema==='packproof.guided-activation-plan/v1'&&hash(body)===planSha256&&fresh(plan.preparedAt,now)&&Date.parse(plan.expiresAt)>now,'PLAN_CHANGED_OR_EXPIRED');
}
export function guidedUpdateRequest(plan,snapshot,request,publication,now=Date.now()) {
  validPlan(plan,now);const s=verifyGuidedRuntime(snapshot,request,publication,now);
  check(plan.source===request.source&&plan.runtimeSource===publication.source&&plan.image===publication.candidate,'PLAN_SOURCE');
  verifyReleasePins(s,plan.beforePins);check(guidedPreservationHash(s)===plan.preservationSha256,'CONFIGURATION_DRIFT');
  return structuredClone(plan.update);
}
export function verifyGuidedResult(plan,snapshot,request,publication,now=Date.now()) {
  const {planSha256,...body}=plan;check(hash(body)===planSha256,'PLAN_CHANGED');
  const s=verifyGuidedRuntime(snapshot,request,publication,now);
  check(guidedPreservationHash(s)===plan.preservationSha256&&hash(s.api.express.activeConfigurations[0].primaryContainer)===plan.afterPrimaryContainerSha256,'RESULT_CONFIGURATION_DRIFT');
  return {schema:'packproof.guided-activation-result/v1',operation:plan.operation,source:plan.source,runtimeSource:plan.runtimeSource,image:plan.image,
    selectionSha256:plan.selectionSha256,scopeSha256:plan.scopeSha256,planSha256,changed:plan.changed,pins:releasePins(s),
    workerUnchanged:true,assistantUnchanged:true,onlyGuidedSettingChanged:true,completedAt:new Date(now).toISOString(),
    ...(plan.changed&&plan.operation==='activate'?{rollback:{previousApiTaskDefinition:plan.previousApiTaskDefinition,
      previousPrimaryContainerSha256:plan.beforePrimaryContainerSha256,activatedPrimaryContainerSha256:plan.afterPrimaryContainerSha256}}:{})};
}
export function guidedPhaseRunId(runId,phase) {
  check(/^[0-9]{1,19}$/.test(runId??'')&&['precheck','postcheck'].includes(phase),'RUN_ID');
  return runId+(phase==='precheck'?'1':'2');
}
export function guidedSessionPolicy(phase,{source,snapshot,runId}) {
  if(phase==='observe')return recoverySessionPolicy('hydrate',{source});
  if(['precheck','postcheck'].includes(phase))return recoverySessionPolicy('facility',{source,snapshot,runId:guidedPhaseRunId(runId,phase)});
  check(phase==='apply','POLICY_PHASE');const api=snapshot.api;
  return sessionPolicy('deploy',{sourceSha:source,taskRoleArn:api.taskDefinition.taskRoleArn,executionRoleArn:api.taskDefinition.executionRoleArn,
    infrastructureRoleArn:api.express.infrastructureRoleArn,apiTaskFamily:api.taskDefinition.family});
}
