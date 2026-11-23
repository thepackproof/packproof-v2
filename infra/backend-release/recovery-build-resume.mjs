// Recover one exactly reviewed CodeBuild execution before considering a new build.
// All cloud operations and receipt writes are injected; this module has no I/O.
import {TARGET} from './backend-deployment-plan.mjs';

export const recoveryBuildDiscoveryLimit=Object.freeze({pages:5,pageSize:100,receiptMatches:20});
const check=(ok,code)=>{if(!ok)throw Error('RECOVERY_BUILD_'+code);};
const statuses=new Set(['IN_PROGRESS','SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT']);
const failures=new Set(['FAILED','FAULT','STOPPED','TIMED_OUT']);
const validId=id=>typeof id==='string'&&id.startsWith(TARGET.serviceName+':')&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id.slice(TARGET.serviceName.length+1));
const variables=build=>Array.isArray(build?.environment?.environmentVariables)?build.environment.environmentVariables:[];
const sourceTypes=new Set(['BITBUCKET','CODECOMMIT','CODEPIPELINE','GITHUB','GITHUB_ENTERPRISE','GITLAB','GITLAB_SELF_MANAGED','NO_SOURCE','S3']);
const gitSourceTypes=new Set(['BITBUCKET','CODECOMMIT','GITHUB','GITHUB_ENTERPRISE','GITLAB','GITLAB_SELF_MANAGED']);
function classifiable(build) {
  const source=build?.source,values=build?.environment?.environmentVariables;
  return sourceTypes.has(source?.type)&&
    (['NO_SOURCE','CODEPIPELINE'].includes(source.type)?
      source.location===undefined||typeof source.location==='string':
      typeof source.location==='string'&&source.location.length>0)&&
    (!gitSourceTypes.has(source.type)||/^[a-f0-9]{40}$/.test(build.sourceVersion??'')||/^[a-f0-9]{40}$/.test(build.resolvedSourceVersion??''))&&
    Array.isArray(values)&&values.every(v=>typeof v?.name==='string'&&v.name.length>0&&
      typeof v.value==='string'&&['PLAINTEXT','PARAMETER_STORE','SECRETS_MANAGER'].includes(v.type));
}

function validatePrepared(prepared) {
  const r=prepared?.request,p=prepared?.receipt;
  check(r?.projectName===TARGET.serviceName&&r.sourceTypeOverride==='S3'&&
    /^[a-f0-9]{40}$/.test(p?.source??'')&&
    typeof r.sourceLocationOverride==='string'&&r.sourceLocationOverride.includes('/security-release/'+p.source+'/')&&
    typeof r.sourceVersion==='string'&&r.sourceVersion.length>0&&
    typeof r.buildspecOverride==='string'&&r.buildspecOverride.length>0&&
    Array.isArray(r.environmentVariablesOverride)&&r.environmentVariablesOverride.length===5,'PREPARED_REQUEST');
  return r;
}
function claimsSource(build,prepared) {
  const p=prepared.receipt;
  return build?.sourceVersion===p.source||build?.resolvedSourceVersion===p.source||
    (typeof build?.source?.location==='string'&&build.source.location.includes('/security-release/'+p.source+'/'))||
    variables(build).some(v=>v?.name==='REVIEWED_SOURCE_SHA'&&v.value===p.source||
      v?.name==='CANDIDATE_TAG'&&v.value===p.candidateTag||v?.name==='FALLBACK_TAG'&&v.value===p.fallbackTag);
}
function matchesPins(build,request) {
  return build?.projectName===request.projectName&&build.source?.type===request.sourceTypeOverride&&
    build.source.location===request.sourceLocationOverride&&build.sourceVersion===request.sourceVersion&&
    build.source.buildspec===request.buildspecOverride&&request.environmentVariablesOverride.every(wanted=>{
      const found=variables(build).filter(v=>v?.name===wanted.name);
      return found.length===1&&found[0].type===wanted.type&&found[0].value===wanted.value;
    });
}
function validateBuildState(build) {
  check(!failures.has(build.buildStatus),'SAME_SOURCE_FAILED');
  check(build.buildStatus==='IN_PROGRESS'&&build.buildComplete===false||
    build.buildStatus==='SUCCEEDED'&&build.buildComplete===true,'STATE');
}
export function verifyRecoveryBuildObservation(build,prepared) {
  const request=validatePrepared(prepared);
  check(validId(build?.id)&&matchesPins(build,request),'SAME_SOURCE_CONFLICT');
  validateBuildState(build);
  return build;
}
export function selectRecoveryBuild(prepared,builds) {
  validatePrepared(prepared);
  check(Array.isArray(builds)&&builds.length<=recoveryBuildDiscoveryLimit.pages*recoveryBuildDiscoveryLimit.pageSize,'DISCOVERY_LIMIT');
  const ids=builds.map(build=>build?.id);
  check(ids.every(validId)&&new Set(ids).size===ids.length&&
    builds.every(build=>build.projectName===prepared.request.projectName),'DISCOVERY_BINDING');
  check(builds.every(classifiable),'DISCOVERY_UNCLASSIFIABLE');
  const matches=builds.filter(build=>claimsSource(build,prepared));
  // A failed or differently pinned execution for this source is evidence to
  // review, never permission to silently pick a newer execution or retry.
  for(const build of matches)verifyRecoveryBuildObservation(build,prepared);
  check(matches.length<=1,'DUPLICATE_MATCH');
  return matches[0]??null;
}
function discoveryReceipt(prepared,builds,complete) {
  const matches=builds.filter(build=>validId(build?.id)&&claimsSource(build,prepared));
  return {schema:'packproof.recovery-build-discovery/v1',source:prepared.receipt.source,
    projectName:prepared.request.projectName,complete,observedBuilds:builds.length,
    matchingBuildCount:matches.length,matchingBuildsTruncated:matches.length>recoveryBuildDiscoveryLimit.receiptMatches,
    matchingBuilds:matches.slice(0,recoveryBuildDiscoveryLimit.receiptMatches).map(build=>({
      id:build.id,status:statuses.has(build.buildStatus)?build.buildStatus:'UNRECOGNIZED'
    }))};
}
export async function startOrResumeRecoveryBuild(prepared,{listBuilds,readBuilds,startBuild,recordDiscovery,recordStarted}) {
  const request=validatePrepared(prepared),builds=[],seenIds=new Set(),seenTokens=new Set();
  let nextToken,complete=false;
  try {
    for(let page=0;page<recoveryBuildDiscoveryLimit.pages;page++) {
      const listed=await listBuilds({projectName:request.projectName,...(nextToken?{nextToken}:{})});
      check(Array.isArray(listed?.ids)&&listed.ids.length<=recoveryBuildDiscoveryLimit.pageSize&&
        listed.ids.every(validId)&&new Set(listed.ids).size===listed.ids.length&&
        listed.ids.every(id=>!seenIds.has(id)),'DISCOVERY_IDS');
      for(const id of listed.ids)seenIds.add(id);
      if(listed.ids.length) {
        const observed=await readBuilds({ids:listed.ids});
        check(Array.isArray(observed?.builds)&&observed.builds.length===listed.ids.length&&
          Array.isArray(observed.buildsNotFound??[])&&!(observed.buildsNotFound??[]).length,'DISCOVERY_MISSING');
        const returned=observed.builds.map(build=>build?.id);
        check(returned.every(id=>listed.ids.includes(id))&&new Set(returned).size===returned.length&&
          observed.builds.every(build=>build.projectName===request.projectName),'DISCOVERY_BINDING');
        builds.push(...observed.builds);
        check(observed.builds.every(classifiable),'DISCOVERY_UNCLASSIFIABLE');
      }
      nextToken=listed.nextToken;
      if(nextToken===undefined||nextToken===null||nextToken===''){complete=true;break;}
      check(typeof nextToken==='string'&&nextToken.length<=2048&&!seenTokens.has(nextToken),'DISCOVERY_TOKEN');
      seenTokens.add(nextToken);
    }
  } finally {
    // Keep only bounded, validated public identities even when discovery fails.
    await recordDiscovery(discoveryReceipt(prepared,builds,complete));
  }
  check(complete,'DISCOVERY_LIMIT');
  const existing=selectRecoveryBuild(prepared,builds);
  const selected=existing??(await startBuild(request))?.build;
  check(validId(selected?.id)&&selected.projectName===request.projectName,'STARTED_ID');
  const pinsVerified=matchesPins(selected,request);
  await recordStarted({schema:'packproof.recovery-build-started/v1',source:prepared.receipt.source,
    buildId:selected.id,status:statuses.has(selected.buildStatus)?selected.buildStatus:'UNRECOGNIZED',
    resumed:!!existing,requestPinsVerified:pinsVerified});
  // Persist the actual returned ID before further validation or any polling.
  check(pinsVerified,'SAME_SOURCE_CONFLICT');
  validateBuildState(selected);
  return {build:selected,resumed:!!existing};
}
export function publicRecoveryBuildPins(verified) {
  const image=value=>typeof value==='string'&&value.startsWith(TARGET.repository+'@sha256:')&&
    /^[a-f0-9]{64}$/.test(value.slice((TARGET.repository+'@sha256:').length));
  check(/^[a-f0-9]{40}$/.test(verified?.source??'')&&/^[a-f0-9]{64}$/.test(verified?.archiveSha256??'')&&
    /^[a-zA-Z0-9_.+\/=\-]{1,1024}$/.test(verified?.sourceVersion??'')&&verified.sourceVersion!=='null'&&
    validId(verified.buildId)&&['predecessor','candidate','fallback'].every(key=>image(verified[key]))&&
    new Set([verified.predecessor,verified.candidate,verified.fallback]).size===3,'PUBLIC_RECEIPT');
  return Object.fromEntries(['source','archiveSha256','sourceVersion','buildId','predecessor','candidate','fallback'].map(key=>[key,verified[key]]));
}
