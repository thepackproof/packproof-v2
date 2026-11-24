// Fixed phase coordinator. All raw requests, runtime configuration and plaintext
// observations stay in the runner's private directory; only whitelisted receipts
// and the operator-encrypted final inspection can be published.
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {observeRuntime} from './connect-hosted-runtime-observe.mjs';
import {prepareRecoveryImages} from './recovery-image-builds.mjs';
import {normalizeRecoverySnapshot,verifyRecoveryRelease} from './recovery-runtime-release.mjs';
import {verifyReleasePins,recoveryFacilityCleanupRequest} from './recovery-hosted-release.mjs';
import {prepareRecoveryFacilityInspection,runRecoveryFacilityInspection,collectRecoveryFacilityInspection} from './recovery-facility-inspection.mjs';
import {decryptFacilityReceipt} from './logistics-facility-inspect.mjs';
import {verifyRuntimeInputs} from '../connect-portal-runtime.mjs';
import {guidedInventory,validateGuidedRequest,verifyGuidedRuntime,createGuidedPlan,guidedUpdateRequest,
  verifyGuidedResult,guidedPhaseRunId,guidedSessionPolicy} from './recovery-guided-activation.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const check=(ok,code)=>{if(!ok)throw Error('GUIDED_ACTIVATION_'+code);};
export const guidedToolingPaths=Object.freeze(['infra/backend-release','infra/backend-control-plane-readonly.mjs','infra/backend-service-state.mjs',
  'infra/connect-portal-runtime.mjs','.github/workflows/connect-guided-activation.yml']);
export function safeGuidedFailure(error) {
  return /^(GUIDED_ACTIVATION|RECOVERY_FACILITY|FACILITY_INSPECT|HOSTED_OBSERVE|OWNER_TASK|CONNECT_RECOVERY_RUNTIME)_[A-Z0-9_]+$/.test(error?.message)?error.message:'GUIDED_ACTIVATION_FAILED';
}
const awsFailureCodes=new Set(['AccessDenied','AccessDeniedException','UnauthorizedOperation','InvalidInput','InvalidInputException',
  'InvalidClientTokenId','UnrecognizedClientException','ExpiredToken','ExpiredTokenException','RequestExpired','ValidationError','ValidationException',
  'NoSuchEntity','NoSuchEntityException','ResourceNotFoundException','Throttling','ThrottlingException','RequestLimitExceeded',
  'TooManyRequestsException','ServiceFailure','ServiceUnavailable','ServiceUnavailableException','InternalFailure','InternalError']);
export function guidedAwsFailureCode(error) {
  if(error?.code==='ETIMEDOUT')return 'TIMEOUT';
  const raw=error?.stderr,stderr=typeof raw==='string'?raw.slice(0,8192):Buffer.isBuffer(raw)?raw.subarray(0,8192).toString('utf8'):'';
  const code=stderr.match(/(?:^|\n)An error occurred \(([A-Za-z][A-Za-z0-9]{0,63})\) when calling the [A-Za-z][A-Za-z0-9]{0,79} operation:/)?.[1];
  return awsFailureCodes.has(code)?code.toUpperCase():'FAILED';
}
function command(name,args){return execFileSync(name,args,{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});}
let request,state,directory,evidence,sequence=0;
async function json(file,value){await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function receipt(name,value){await json(join(evidence,name+'.json'),value);}
async function save(){await json(join(directory,'state.json'),state);}
async function aws(service,operation,input={}) {
  const file=join(directory,'aws-'+(++sequence)+'.json');await json(file,input);
  try{return JSON.parse(command('aws',[service,operation,'--cli-input-json','file://'+file,'--region',TARGET.region,'--output','json','--no-cli-pager']));}
  catch(error){throw Error('GUIDED_ACTIVATION_AWS_'+service.replaceAll('-','_').toUpperCase()+'_'+operation.replaceAll('-','_').toUpperCase()+'_'+guidedAwsFailureCode(error));}
}
const current=async()=>normalizeRecoverySnapshot((await observeRuntime()).snapshot);
async function logEvents(group,stream) {
  const events=[];let token;
  for(let page=0;page<100;page++) {
    const result=await aws('logs','get-log-events',{logGroupName:group,logStreamName:stream,startFromHead:true,limit:10000,...(token?{nextToken:token}:{})});
    events.push(...(result.events??[]));if(!result.nextForwardToken||result.nextForwardToken===token)return events;token=result.nextForwardToken;
  }
  throw Error('GUIDED_ACTIVATION_LOG_PAGINATION');
}
function verifyCi(ci,source) {
  check(ci?.repository?.full_name==='thepackproof/packproof-v2'&&ci.name==='CI'&&ci.path==='.github/workflows/ci.yml'&&
    ci.head_sha===source&&ci.head_branch==='main'&&['push','workflow_dispatch'].includes(ci.event)&&ci.status==='completed'&&ci.conclusion==='success','SOURCE_CI');
}
async function observe(input) {
  const p=request.build,prepared=prepareRecoveryImages({source:p.source,archiveSha256:p.archiveSha256,sourceVersion:p.sourceVersion,predecessorImage:p.predecessor});
  const build=(await aws('codebuild','batch-get-builds',{ids:[p.buildId]})).builds?.[0];check(build?.id===p.buildId,'ACTUAL_BUILD');
  const readImage=tag=>aws('ecr','describe-images',{repositoryName:TARGET.serviceName,imageIds:[{imageTag:tag}]});
  const [candidate,fallback,snapshot]=await Promise.all([readImage(prepared.receipt.candidateTag),readImage(prepared.receipt.fallbackTag),current()]);
  const buildLog={group:build.logs?.groupName,stream:build.logs?.streamName,
    events:await logEvents(build.logs?.groupName,build.logs?.streamName)};
  const publication=verifyRecoveryRelease({images:prepared.receipt,archiveSha256:p.archiveSha256,sourceVersion:p.sourceVersion,
    ci:input.runtimeCi,build,candidate,fallback,buildLog});
  verifyGuidedRuntime(snapshot,request,publication);verifyReleasePins(snapshot,request.expected);
  const runtimeInputs=verifyRuntimeInputs(root,p.source,request.source,p.candidate);
  state={source:request.source,requestSha256:hash(request),snapshot,publication,runtimeInputs};
  if(request.operation==='rollback')state.previousTaskDefinition=(await aws('ecs','describe-task-definition',{
    taskDefinition:request.rollback.previousApiTaskDefinition})).taskDefinition;
  await save();await receipt('observation',{source:request.source,runtimeSource:p.source,image:p.candidate,
    requestSha256:hash(request),runtimeInputsSha256:runtimeInputs.runtimeInputsSha256,actualBuildVerified:true,
    postCandidateServiceIdentityVerified:true,readOnly:true,observedAt:snapshot.observedAt});
}
async function stopped(taskArn) {
  const deadline=Date.now()+5*60000;
  while(Date.now()<deadline) {
    const value=await aws('ecs','describe-tasks',{cluster:TARGET.cluster,tasks:[taskArn]});
    check(!value.failures?.length&&value.tasks?.length===1&&value.tasks[0].taskArn===taskArn,'TASK_OBSERVATION');
    if(value.tasks[0].lastStatus==='STOPPED')return value.tasks[0];await wait(5000);
  }
  throw Error('GUIDED_ACTIVATION_TASK_TIMEOUT');
}
async function inspectFacility(phase,recipientPublicKeySpki) {
  const snapshot=await current();verifyGuidedRuntime(snapshot,request,state.publication);
  if(phase==='precheck')verifyReleasePins(snapshot,request.expected);
  else verifyGuidedResult(state.plan,snapshot,request,state.publication);
  const prepared=prepareRecoveryFacilityInspection({snapshot,subjectSha256:request.facility.subjectSha256,recipientPublicKeySpki,
    inventorySha256:guidedInventory,runId:guidedPhaseRunId(process.env.GITHUB_RUN_ID,phase)});
  const registered=await aws('ecs','register-task-definition',prepared.request);
  const cleanup=recoveryFacilityCleanupRequest({prepared,registered}),definition=cleanup.taskDefinition;
  let taskArn,finished=false;
  try {
    const fresh=await current();verifyGuidedRuntime(fresh,request,state.publication);
    if(phase==='precheck')verifyReleasePins(fresh,request.expected);else verifyGuidedResult(state.plan,fresh,request,state.publication);
    const launch=await aws('ecs','run-task',runRecoveryFacilityInspection({prepared,registered,snapshot:fresh}));
    check(!launch.failures?.length&&launch.tasks?.length===1,'TASK_LAUNCH');taskArn=launch.tasks[0].taskArn;
    const task=await stopped(taskArn);finished=true;
    const actual=await aws('ecs','describe-task-definition',{taskDefinition:task.taskDefinitionArn});
    const stream=prepared.logPrefix+'/'+prepared.containerName+'/'+taskArn.split('/').at(-1),deadline=Date.now()+45000;
    let observation;
    while(!observation) {
      try{observation=collectRecoveryFacilityInspection({prepared,registered:actual,task,logGroup:prepared.logGroup,logStream:stream,
        events:await logEvents(prepared.logGroup,stream)});}
      catch(error){if(error.message!=='RECOVERY_FACILITY_ONE_RECEIPT'||Date.now()>=deadline)throw error;await wait(3000);}
    }
    return {...observation,prepared,taskArn,taskDefinition:definition};
  } finally {
    if(taskArn&&!finished)await aws('ecs','stop-task',{cluster:TARGET.cluster,task:taskArn,reason:'Bounded guided facility inspection cleanup'});
    await aws('ecs','deregister-task-definition',cleanup);
  }
}
async function precheck() {
  // This separate ephemeral recipient is generated here, never supplied by the
  // request, written to disk, logged or retained. The operator key stays local.
  const key=generateKeyPairSync('x25519');
  const observed=await inspectFacility('precheck',key.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const report=decryptFacilityReceipt(observed.envelope,key.privateKey.export({type:'pkcs8',format:'pem'}),{
    source:request.build.source,image:request.build.candidate,inventorySha256:guidedInventory,
    actualTask:observed.taskArn,subjectSha256:request.facility.subjectSha256});
  const snapshot=await current();
  state.plan=createGuidedPlan({snapshot,request,publication:state.publication,report,previousTaskDefinition:state.previousTaskDefinition});
  state.snapshot=snapshot;state.precheckTask=observed.taskArn;await save();
  await receipt('precheck',{source:request.source,runtimeSource:request.build.source,image:request.build.candidate,
    selectionSha256:request.facility.selectionSha256,scopeSha256:request.facility.scopeSha256,task:observed.taskArn,
    inspectorSha256:observed.prepared.inspectorSha256,privateObservationAuthenticated:true,
    currentBoundScopeVerified:true,planSha256:state.plan.planSha256,changesGuidedSetting:state.plan.changed,readOnly:true});
}
async function waitApi() {
  const deadline=Date.now()+15*60000;
  while(Date.now()<deadline) {
    const list=await aws('ecs','list-service-deployments',{cluster:TARGET.cluster,service:TARGET.serviceName});
    const latest=[...(list.serviceDeployments??[])].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    check(latest?.serviceDeploymentArn,'API_DEPLOYMENT');
    const deployment=(await aws('ecs','describe-service-deployments',{serviceDeploymentArns:[latest.serviceDeploymentArn]})).serviceDeployments?.[0];
    check(!['ROLLBACK_SUCCESSFUL','ROLLBACK_FAILED','STOPPED'].includes(deployment?.status),'API_UPDATE_ROLLED_BACK');
    if(deployment?.status==='SUCCESSFUL') {
      const snapshot=await current();
      if(hash(snapshot.api.express.activeConfigurations[0].primaryContainer)===state.plan.afterPrimaryContainerSha256) {
        verifyGuidedResult(state.plan,snapshot,request,state.publication);return snapshot;
      }
    }
    await wait(10000);
  }
  throw Error('GUIDED_ACTIVATION_API_UPDATE_TIMEOUT');
}
async function apply() {
  const snapshot=await current(),update=guidedUpdateRequest(state.plan,snapshot,request,state.publication);
  let completed=snapshot;
  if(update) {
    state.updateAttempted=true;await save();await aws('ecs','update-express-gateway-service',update);
    state.updateAcknowledged=true;await save();completed=await waitApi();
  }
  state.result=verifyGuidedResult(state.plan,completed,request,state.publication);state.snapshot=completed;await save();
  await receipt('configuration',{...state.result,finalPrivateInspectionPending:true,automaticRollback:false});
}
async function postcheck() {
  check(state.result,'CONFIGURATION_RESULT_REQUIRED');
  const observation=await inspectFacility('postcheck',request.facility.recipientPublicKeySpki);
  const snapshot=await current(),result=verifyGuidedResult(state.plan,snapshot,request,state.publication);
  await receipt('facility-encrypted',{source:request.source,runtimeSource:request.build.source,inspectorSha256:observation.prepared.inspectorSha256,
    scriptSha256:observation.prepared.scriptSha256,taskDefinition:observation.taskDefinition,configurationPreserved:true,
    taskExitVerified:true,innerReceiptAuthentication:'REQUIRES_LOCAL_PRIVATE_KEY',envelope:observation.envelope});
  await receipt('result',{...result,precheckTask:state.precheckTask,postcheckTask:observation.taskArn,
    finalPrivateInspection:'REQUIRES_LOCAL_PRIVATE_KEY',humanWorkspaceAcceptance:false,serviceHeartbeatAcceptance:false});
}
async function main() {
  const [phase,inputFile,output]=process.argv.slice(2);
  check(process.argv.length===5&&/^(policy-)?(observe|precheck|apply|postcheck)$/.test(phase),'PHASE');
  check(process.env.GITHUB_REPOSITORY==='thepackproof/packproof-v2'&&process.env.GITHUB_REF==='refs/heads/main','MAIN_ONLY');
  const input=JSON.parse(await readFile(inputFile,'utf8'));const {ci,runtimeCi,...reviewed}=input;
  request=validateGuidedRequest(reviewed);verifyCi(ci,request.source);verifyCi(runtimeCi,request.build.source);
  check(runtimeCi.id===request.build.ciRunId,'RUNTIME_CI_PIN');
  command('git',['merge-base','--is-ancestor',request.source,process.env.GITHUB_SHA]);
  command('git',['diff','--quiet',request.source,process.env.GITHUB_SHA,'--',...guidedToolingPaths]);
  directory=output;evidence=join(directory,'receipts');await mkdir(evidence,{recursive:true,mode:0o700});
  if(!['policy-observe','observe'].includes(phase)) {
    state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
    check(state.source===request.source&&state.requestSha256===hash(request),'STATE_REQUEST');
  }
  if(phase.startsWith('policy-')) {
    const policy=guidedSessionPolicy(phase.slice(7),{source:request.build.source,snapshot:state?.snapshot,runId:process.env.GITHUB_RUN_ID});
    check(process.env.GITHUB_OUTPUT,'WORKFLOW_OUTPUT');await appendFile(process.env.GITHUB_OUTPUT,'policy='+policy+'\n');return;
  }
  const identity=await aws('sts','get-caller-identity');
  check(identity.Account===TARGET.account&&identity.Arn?.startsWith('arn:aws:sts::'+TARGET.account+':assumed-role/PackProofGitHubDeploy/'),'OIDC_IDENTITY');
  if(phase==='observe')await observe(input);else if(phase==='precheck')await precheck();else if(phase==='apply')await apply();else await postcheck();
  console.log(JSON.stringify({phase,source:request.source,completed:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(async error=>{
  const code=safeGuidedFailure(error);
  if(evidence)await receipt('failure',{code,source:request?.source,operation:request?.operation,
    updateAttempted:state?.updateAttempted===true,updateAcknowledged:state?.updateAcknowledged===true,automaticRollback:false});
  console.error(code);process.exitCode=1;
});
