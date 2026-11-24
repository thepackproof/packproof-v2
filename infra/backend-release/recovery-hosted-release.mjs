// GitHub Actions coordinator for the reviewed129 -> bridge ->130 -> candidate
// sequence. Offline constructors remain independently usable. This entry point
// never accepts an arbitrary command, role override, SQL or feature activation.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {observeRuntime} from './connect-hosted-runtime-observe.mjs';
import {observeOwner} from './connect-hosted-owner-task.mjs';
import {collectTaskReceipt} from './connect-hosted-task-receipt.mjs';
import {prepareRecoveryImages} from './recovery-image-builds.mjs';
import {startOrResumeRecoveryBuild,verifyRecoveryBuildObservation,publicRecoveryBuildPins} from './recovery-build-resume.mjs';
import {normalizeRecoverySnapshot,recoveryPreservationHash,verifyRecoveryRelease,createRecoveryRuntimeReview,
  recoveryProbeRegistrations,recoveryProbeRunRequest,collectRecoveryProbeReceipt,createRecoveryRuntimePlan,
  recoveryWorkerRegistration,recoveryWorkerUpdate,recoveryApiUpdate} from './recovery-runtime-release.mjs';
import {createRecoveryOwnerReview,registerRecoveryOwner,runRecoveryOwner,verifyRecoveryApplication} from './recovery-hosted-owner-requests.mjs';
import {reconstructionDigest as ownerDigest} from './reconstruction-v11-release-review.mjs';
import {prepareRecoveryFacilityInspection,runRecoveryFacilityInspection,collectRecoveryFacilityInspection} from './recovery-facility-inspection.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const worker='packproof-records-worker',bucket='packproof-v2-staging-build-'+TARGET.account;
const check=(ok,code)=>{if(!ok)throw Error('RECOVERY_RELEASE_'+code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env=c=>Object.fromEntries((c.environment??[]).map(x=>[x.name,x.value]));
const primary=(s,kind)=>s[kind].taskDefinition.containerDefinitions.find(c=>env(c).PACKPROOF_PROCESS_ROLE===kind);
const expiry=()=>new Date(Date.now()+110*60_000).toISOString();
const safeCode=e=>/^[A-Z0-9_]+$/.test(e?.message??'')?e.message:'RECOVERY_RELEASE_OPERATION_FAILED';
const readActions=['sts:GetCallerIdentity','ecs:Describe*','ecs:List*','ec2:Describe*','elasticloadbalancing:Describe*',
  'rds:DescribeDBInstances','iam:GetRole','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies',
  'iam:SimulatePrincipalPolicy','secretsmanager:DescribeSecret','codebuild:BatchGetProjects','ecr:DescribeRepositories',
  'ecr:GetLifecyclePolicy','s3:GetBucketVersioning'];
export const recoveryPhases=Object.freeze(['inspect','facility-inspect','build','bridge','rehearse','apply','promote']);
export function authorizeCoordinatorPhase(phase,requested) {
  const allowed={
    'policy-inspect':recoveryPhases,inspect:recoveryPhases,
    'policy-build':['build'],build:['build'],
    'policy-hydrate':['bridge','rehearse','apply','promote'],hydrate:['bridge','rehearse','apply','promote'],
    'policy-runtime':['bridge','promote'],fallback:['bridge'],candidate:['promote'],
    'policy-owner':['rehearse','apply'],rehearse:['rehearse'],apply:['apply'],
    'policy-facility':['facility-inspect'],'facility-inspect':['facility-inspect']
  };
  check(allowed[phase]?.includes(requested),'REQUESTED_PHASE_MISMATCH');
}
export function ownerReviewFromReceipt(receipt,pin,source,images) {
  const registration=receipt?.registered?.taskDefinition??receipt?.registered;
  const encoded=registration?.containerDefinitions?.[0]?.environment?.find(x=>x.name==='PACKPROOF_HOSTED_MIGRATION_REVIEW_JSON')?.value;
  const review=JSON.parse(encoded??'null'),report=receipt?.report;
  check(review?.source===source&&review.candidateImage===images.candidate&&review.bridgeImage===images.fallback&&
    ownerDigest(review)===pin&&report?.schema==='packproof.hosted-recovery-owner-receipt/v1'&&
    report.mode==='rehearse'&&report.rolledBack===true&&report.reviewSha256===pin&&report.source===source&&report.image===images.candidate,'OWNER_REVIEW_PIN_CHANGED');
  return review;
}

export function releasePins(snapshot) {
  const s=normalizeRecoverySnapshot(snapshot);
  return {api:{source:s.api.meta.commit,image:s.api.meta.image,taskDefinition:s.api.taskDefinition.taskDefinitionArn},
    worker:{source:env(primary(s,'worker')).PACKPROOF_RELEASE_SHA,image:primary(s,'worker').image,taskDefinition:s.worker.taskDefinition.taskDefinitionArn},
    topologySha256:hash(s.topology),preservationSha256:recoveryPreservationHash(s)};
}
export function verifyReleasePins(snapshot,expected) {
  check(hash(releasePins(snapshot))===hash(expected),'INSPECTED_RUNTIME_CHANGED');
  check(expected.api.image===expected.worker.image && expected.api.source===expected.worker.source,'COMMON_PREDECESSOR_REQUIRED');
}
export function recoverySessionPolicy(stage,{source,snapshot,owner,runId}) {
  check(/^[a-f0-9]{40}$/.test(source??''),'SOURCE');
  const a=TARGET.account,r=TARGET.region,ecs='arn:aws:ecs:'+r+':'+a+':',ecr='arn:aws:ecr:'+r+':'+a+':repository/'+TARGET.serviceName;
  const statements=[{Effect:'Allow',Action:['runtime','facility'].includes(stage)?readActions.filter(x=>/^(sts|ecs|ec2|elasticloadbalancing):/.test(x)):readActions,Resource:'*'}];
  const allow=(Action,Resource,Condition)=>statements.push({Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
  if(stage==='build' || stage==='hydrate') {
    if(stage==='build') {
      allow(['s3:GetObject','s3:GetObjectVersion','s3:PutObject'],'arn:aws:s3:::'+bucket+'/security-release/'+source+'/*');
      allow(['codebuild:StartBuild','codebuild:ListBuildsForProject'],'arn:aws:codebuild:'+r+':'+a+':project/'+TARGET.serviceName);
    }
    // AWS authorizes both build metadata reads against the project resource.
    allow('codebuild:BatchGetBuilds','arn:aws:codebuild:'+r+':'+a+':project/'+TARGET.serviceName);
    allow(['ecr:DescribeImages','ecr:BatchGetImage'],ecr);
    allow('logs:GetLogEvents',(stage==='hydrate'?['/aws/codebuild/'+TARGET.serviceName,'/ecs/packproof-v2-staging-api']:['/aws/codebuild/'+TARGET.serviceName]).map(x=>'arn:aws:logs:'+r+':'+a+':log-group:'+x+':log-stream:*'));
  } else if(stage==='facility') {
    const api=snapshot?.api,liveSource=api?.meta?.commit;
    check(/^[a-f0-9]{40}$/.test(liveSource??'')&&/^[0-9]{1,20}$/.test(runId??''),'FACILITY_RUNTIME_PINS');
    const family='packproof-security-verifier-'+liveSource.slice(0,12)+'-'+runId;
    allow(['ecs:RegisterTaskDefinition','ecs:DeregisterTaskDefinition','ecs:RunTask'],ecs+'task-definition/'+family+':*');
    allow('ecs:TagResource',ecs+'task/'+TARGET.cluster+'/*',{StringEquals:{'ecs:CreateAction':'RunTask','aws:RequestTag/packproof-release':liveSource}});
    allow('ecs:StopTask',ecs+'task/'+TARGET.cluster+'/*',{StringEquals:{'ecs:ResourceTag/packproof-release':liveSource}});
    const roles=[api.taskDefinition?.taskRoleArn,api.taskDefinition?.executionRoleArn];
    check(roles.every(value=>typeof value==='string'&&value.startsWith('arn:aws:iam::'+a+':role/')),'OBSERVED_ROLES_REQUIRED');
    allow('iam:PassRole',roles,{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}});
    const group=primary(snapshot,'api').logConfiguration?.options?.['awslogs-group'];
    check(typeof group==='string'&&/^\/[A-Za-z0-9/_.-]+$/.test(group),'LOG_GROUP');
    allow('logs:GetLogEvents','arn:aws:logs:'+r+':'+a+':log-group:'+group+':log-stream:*');
  } else if(stage==='runtime' || stage==='owner') {
    check(snapshot?.api?.taskDefinition && snapshot?.worker?.taskDefinition,'OBSERVED_RUNTIME_REQUIRED');
    const families=stage==='owner'?['packproof-recovery-owner-'+source.slice(0,12)+'-*']:
      ['packproof-recovery-probe-'+source.slice(0,12)+'-*',snapshot.worker.taskDefinition.family,snapshot.api.taskDefinition.family];
    check(families.every(x=>/^packproof-[A-Za-z0-9_*-]+$/.test(x)),'TASK_FAMILY');
    allow(['ecs:RegisterTaskDefinition','ecs:DeregisterTaskDefinition'],families.map(x=>ecs+'task-definition/'+x+':*'));
    allow('ecs:RunTask',ecs+'task-definition/'+families[0]+':*');
    const roles=stage==='owner'?[owner?.ownerLaunch?.executionRoleArn]:
      [...new Set(['api','worker'].flatMap(k=>[snapshot[k].taskDefinition.taskRoleArn,snapshot[k].taskDefinition.executionRoleArn]))];
    check(roles.every(x=>typeof x==='string'&&x.startsWith('arn:aws:iam::'+a+':role/')),'OBSERVED_ROLES_REQUIRED');
    allow('iam:PassRole',roles,{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}});
    if(stage==='runtime') {
      const infrastructure=snapshot.api.express.infrastructureRoleArn;
      check(typeof infrastructure==='string'&&infrastructure.startsWith('arn:aws:iam::'+a+':role/'),'INFRASTRUCTURE_ROLE');
      allow('iam:PassRole',infrastructure,{StringEquals:{'iam:PassedToService':'ecs.amazonaws.com'}});
      allow('ecs:UpdateService',snapshot.worker.service.serviceArn);
      allow('ecs:UpdateExpressGatewayService',TARGET.serviceArn);
      allow('ecr:BatchGetImage',ecr);
    }
    const groups=stage==='owner'?['/ecs/packproof-v2-staging-api']:
      [...new Set(['api','worker'].map(k=>primary(snapshot,k).logConfiguration?.options?.['awslogs-group']))];
    check(groups.every(x=>typeof x==='string'&&/^\/[A-Za-z0-9/_.-]+$/.test(x)),'LOG_GROUP');
    allow('logs:GetLogEvents',groups.map(x=>'arn:aws:logs:'+r+':'+a+':log-group:'+x+':log-stream:*'));
  } else check(stage==='inspect','POLICY_STAGE');
  const policy=JSON.stringify({Version:'2012-10-17',Statement:statements});
  check(Buffer.byteLength(policy)<=2048,'SESSION_POLICY_TOO_LARGE');
  return policy;
}

let dir,evidence,input,state,sequence=0;
async function json(name,value,publicReceipt=false) {
  const file=join(publicReceipt?evidence:dir,name+'.json');
  await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});return file;
}
async function save(){await json('state',state);}
function command(executable,args){return execFileSync(executable,args,{cwd:root,encoding:'utf8',timeout:90_000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});}
async function aws(service,operation,params={},extra=[]) {
  const file=await json('request-'+(++sequence),params);
  try{return JSON.parse(command('aws',[service,operation,'--cli-input-json','file://'+file,...extra,'--region',TARGET.region,'--output','json','--no-cli-pager']));}
  catch(error){const code=String(error?.stderr??'').match(/\(([A-Za-z0-9]+)\) when calling/)?.[1]??'FAILED';throw Error('AWS_'+service.replaceAll('-','_').toUpperCase()+'_'+operation.replaceAll('-','_').toUpperCase()+'_'+code.toUpperCase());}
}
async function current(){return normalizeRecoverySnapshot((await observeRuntime()).snapshot);}
function preserved(s){check(recoveryPreservationHash(s)===state.expected.preservationSha256,'RUNTIME_CONFIGURATION_DRIFT');}
async function logEvents(group,stream) {
  const events=[];let token;
  for(let page=0;page<100;page++) {
    const result=await aws('logs','get-log-events',{logGroupName:group,logStreamName:stream,startFromHead:true,limit:10000,...(token?{nextToken:token}:{})});
    events.push(...(result.events??[]));
    if(!result.nextForwardToken || result.nextForwardToken===token)return events;
    token=result.nextForwardToken;
  }
  throw Error('RECOVERY_RELEASE_LOG_PAGINATION_LIMIT');
}
async function stopped(arns) {
  const deadline=Date.now()+12*60_000;
  while(Date.now()<deadline) {
    const result=await aws('ecs','describe-tasks',{cluster:TARGET.cluster,tasks:arns});
    check(!result.failures?.length&&result.tasks?.length===arns.length,'TASK_OBSERVATION');
    if(result.tasks.every(x=>x.lastStatus==='STOPPED'))return result.tasks;
    await wait(10_000);
  }
  throw Error('RECOVERY_RELEASE_TASK_TIMEOUT');
}
async function inspect() {
  const snapshot=await current();
  state={source:input.source,snapshot,expected:releasePins(snapshot)};
  if(input.phase!=='inspect')verifyReleasePins(snapshot,input.expected);
  if(input.owner)state.owner=await observeOwner(input.owner);
  if(['rehearse','apply','promote'].includes(input.phase))check(state.owner,'OWNER_INSPECTION_REQUIRED');
  await save();
  await json('inspection',{source:input.source,observedAt:snapshot.observedAt,expected:state.expected,
    ownerMetadataVerified:!!state.owner,readOnly:true,account:TARGET.account,region:TARGET.region},true);
}
async function inspectFacility() {
  check(input.facility&&Object.keys(input.facility).sort().join(',')==='inventorySha256,recipientPublicKeySpki,subjectSha256','FACILITY_REQUEST');
  let snapshot=await current();verifyReleasePins(snapshot,state.expected);
  const prepared=prepareRecoveryFacilityInspection({snapshot,...input.facility,runId:process.env.GITHUB_RUN_ID});
  const registered=await aws('ecs','register-task-definition',prepared.request);
  const definition=registered.taskDefinition?.taskDefinitionArn;
  let taskArn,finished=false;
  try {
    snapshot=await current();verifyReleasePins(snapshot,state.expected);
    const launched=await aws('ecs','run-task',runRecoveryFacilityInspection({prepared,registered,snapshot}));
    check(!launched.failures?.length&&launched.tasks?.length===1,'FACILITY_LAUNCH');taskArn=launched.tasks[0].taskArn;
    const [task]=await stopped([taskArn]);finished=true;
    const actual=await aws('ecs','describe-task-definition',{taskDefinition:task.taskDefinitionArn});
    const stream=prepared.logPrefix+'/'+prepared.containerName+'/'+taskArn.split('/').at(-1);
    let report;const deadline=Date.now()+45_000;
    while(!report) {
      try{report=collectRecoveryFacilityInspection({prepared,registered:actual,task,logGroup:prepared.logGroup,
        logStream:stream,events:await logEvents(prepared.logGroup,stream)});}
      catch(error){if(error.message!=='RECOVERY_FACILITY_ONE_RECEIPT'||Date.now()>=deadline)throw error;await wait(3_000);}
    }
    verifyReleasePins(await current(),state.expected);
    // The public repository receives only authenticated encryption output.
    // Account, installation and location metadata never leave the task in clear.
    await json('facility-encrypted',{source:input.source,runtimeSource:prepared.source,inspectorSha256:prepared.inspectorSha256,
      scriptSha256:prepared.scriptSha256,taskDefinition:definition,configurationPreserved:true,
      taskExitVerified:true,innerReceiptAuthentication:'REQUIRES_LOCAL_PRIVATE_KEY',envelope:report.envelope},true);
  } finally {
    if(taskArn&&!finished)await aws('ecs','stop-task',{cluster:TARGET.cluster,task:taskArn,reason:'Bounded read-only facility inspection cleanup'});
    if(definition)await aws('ecs','deregister-task-definition',{taskDefinition:definition});
  }
}
async function build() {
  const observed=await current();verifyReleasePins(observed,state.expected);
  const db=(await aws('rds','describe-db-instances',{DBInstanceIdentifier:'packproof-v2-staging-db'})).DBInstances?.[0];
  check(db?.DBInstanceStatus==='available'&&db.BackupRetentionPeriod>0&&db.LatestRestorableTime,'DATABASE_RECOVERY_REQUIRED');
  const archive=join(dir,'backend.zip'),archiveTool=join(root,'infra/backend-release/backend-source-archive.py');
  const built=JSON.parse(command('python3',[archiveTool,input.source,archive,'recovery-v1']));
  const verified=JSON.parse(command('python3',[archiveTool,input.source,archive,'recovery-v1','--verify']));
  check(built.allGitBlobBytesVerified&&hash(built)===hash(verified),'ARCHIVE_VERIFICATION');
  const bytes=await readFile(archive),checksum=createHash('sha256').update(bytes).digest('base64');
  const key='security-release/'+input.source+'/'+built.archiveSha256+'/backend.zip';
  try{await aws('s3api','put-object',{Bucket:bucket,Key:key,IfNoneMatch:'*',ChecksumSHA256:checksum},['--body',archive]);}
  catch(error){if(error.message!=='AWS_S3API_PUT_OBJECT_PRECONDITIONFAILED')throw error;}
  const head=await aws('s3api','head-object',{Bucket:bucket,Key:key,ChecksumMode:'ENABLED'});
  check(head.ContentLength===bytes.length&&head.ChecksumSHA256===checksum&&typeof head.VersionId==='string'&&head.VersionId!=='null','VERSIONED_SOURCE_CHECKSUM');
  const prepared=prepareRecoveryImages({source:input.source,archiveSha256:built.archiveSha256,sourceVersion:head.VersionId,predecessorImage:state.expected.api.image});
  const selected=await startOrResumeRecoveryBuild(prepared,{
    listBuilds:params=>aws('codebuild','list-builds-for-project',params,['--no-paginate']),
    readBuilds:params=>aws('codebuild','batch-get-builds',params),
    startBuild:params=>aws('codebuild','start-build',params),
    recordDiscovery:async receipt=>{await json('build-discovery',receipt,true);console.log(JSON.stringify(receipt));},
    recordStarted:async receipt=>{await json('build-started',receipt,true);console.log(JSON.stringify(receipt));}
  });
  const deadline=Date.now()+40*60_000;let result;
  while(Date.now()<deadline) {
    result=(await aws('codebuild','batch-get-builds',{ids:[selected.build.id]})).builds?.[0];
    check(result?.id===selected.build.id,'BUILD_OBSERVATION');
    verifyRecoveryBuildObservation(result,prepared);
    if(result.buildStatus!=='IN_PROGRESS')break;
    console.log(JSON.stringify({phase:'build',status:result.currentPhase}));await wait(20_000);
  }
  check(result?.buildStatus==='SUCCEEDED','BUILD_FAILED');
  const get=tag=>aws('ecr','describe-images',{repositoryName:TARGET.serviceName,imageIds:[{imageTag:tag}]});
  const [candidate,fallback]=await Promise.all([get(prepared.receipt.candidateTag),get(prepared.receipt.fallbackTag)]);
  const buildLog={group:result.logs.groupName,stream:result.logs.streamName,events:await logEvents(result.logs.groupName,result.logs.streamName)};
  state.release={images:prepared.receipt,ci:input.ci,candidate,fallback,build:result,buildLog,archiveSha256:built.archiveSha256,sourceVersion:head.VersionId};
  const verifiedRelease=verifyRecoveryRelease(state.release);await save();
  console.log(JSON.stringify({event:'recovery_images_verified',...publicRecoveryBuildPins(verifiedRelease)}));
  await json('images',{...verifiedRelease,sourceInventorySha256:built.migrationInventorySha256,
    databaseRecovery:{latestRestorableTime:db.LatestRestorableTime,backupRetentionDays:db.BackupRetentionPeriod},completedAt:new Date().toISOString()},true);
}
async function hydrate() {
  const pin=input.build;
  check(pin?.source===input.source&&/^[a-f0-9]{64}$/.test(pin.archiveSha256??'')&&
    typeof pin.buildId==='string'&&pin.buildId.startsWith(TARGET.serviceName+':'),'BUILD_RECEIPT_REQUIRED');
  const prepared=prepareRecoveryImages({source:input.source,archiveSha256:pin.archiveSha256,sourceVersion:pin.sourceVersion,predecessorImage:pin.predecessor});
  const build=(await aws('codebuild','batch-get-builds',{ids:[pin.buildId]})).builds?.[0];
  check(build?.id===pin.buildId,'BUILD_OBSERVATION');
  const get=tag=>aws('ecr','describe-images',{repositoryName:TARGET.serviceName,imageIds:[{imageTag:tag}]});
  const [candidate,fallback]=await Promise.all([get(prepared.receipt.candidateTag),get(prepared.receipt.fallbackTag)]);
  const buildLog={group:build.logs.groupName,stream:build.logs.streamName,events:await logEvents(build.logs.groupName,build.logs.streamName)};
  state.release={images:prepared.receipt,ci:input.ci,candidate,fallback,build,buildLog,archiveSha256:pin.archiveSha256,sourceVersion:pin.sourceVersion};
  const observed=verifyRecoveryRelease(state.release);
  check(observed.candidate===pin.candidate&&observed.fallback===pin.fallback,'BUILD_PUBLICATION_PIN_CHANGED');
  if(['apply','promote'].includes(input.phase)) {
    const names=input.phase==='promote'?['inspection','rehearsal','confirmation','postInspection']:['inspection','rehearsal'];
    state.ownerReceipts={};
    for(const name of names)state.ownerReceipts[name]=collectTaskReceipt(input.ownerReceipts?.[name]);
    const review=ownerReviewFromReceipt(state.ownerReceipts.rehearsal,input.ownerReceipts.reviewSha256,input.source,observed);
    state.ownerReview=review;
    if(input.phase==='promote') {
      state.migration=verifyRecoveryApplication({review,snapshot:await observeOwner(input.owner),...state.ownerReceipts});
      check(state.migration.reviewSha256===input.ownerReceipts.reviewSha256,'MIGRATION_RECEIPT_CHANGED');
    }
  }
  await save();await json('hydration',{source:input.source,buildId:observed.buildId,actualBuildAndRegistryVerified:true,
    actualOwnerTaskReceiptsVerified:!!state.ownerReceipts,readOnly:true},true);
}
async function probes(snapshot,review) {
  const registered={},arns={};
  for(const [label,definition] of Object.entries(recoveryProbeRegistrations(snapshot,review)))
    registered[label]=await aws('ecs','register-task-definition',definition);
  for(const label of Object.keys(registered)) {
    const fresh=await current();preserved(fresh);
    const launched=await aws('ecs','run-task',recoveryProbeRunRequest({snapshot:fresh,review,label,registered:registered[label]}));
    check(!launched.failures?.length&&launched.tasks?.length===1,'PROBE_LAUNCH');arns[label]=launched.tasks[0].taskArn;
  }
  const tasks=await stopped(Object.values(arns)),result={};
  for(const [label,arn] of Object.entries(arns)) {
    const task=tasks.find(x=>x.taskArn===arn),definition=(await aws('ecs','describe-task-definition',{taskDefinition:task.taskDefinitionArn})).taskDefinition;
    const kind=label.split('-')[1],main=definition.containerDefinitions.find(c=>env(c).PACKPROOF_PROCESS_ROLE===kind),o=main.logConfiguration.options;
    const stream=o['awslogs-stream-prefix']+'/'+main.name+'/'+arn.split('/').at(-1);
    result[label]=collectRecoveryProbeReceipt({taskDefinition:definition,task,logGroup:o['awslogs-group'],logStream:stream,events:await logEvents(o['awslogs-group'],stream)});
  }
  await json('probes-'+review.profile,result);return result;
}
async function waitWorker(taskDefinition,deadline) {
  while(Date.now()<deadline) {
    const result=await aws('ecs','describe-services',{cluster:TARGET.cluster,services:[worker]}),service=result.services?.[0];
    check(!result.failures?.length&&service?.serviceName===worker,'WORKER_OBSERVATION');
    if(service.deployments?.some(d=>d.taskDefinition===taskDefinition&&d.rolloutState==='FAILED'))throw Error('RECOVERY_RELEASE_WORKER_FAILED');
    if(service.taskDefinition===taskDefinition&&service.runningCount===service.desiredCount&&service.pendingCount===0&&
      service.deployments?.length===1&&service.deployments[0].rolloutState==='COMPLETED')return;
    await wait(10_000);
  }
  throw Error('RECOVERY_RELEASE_WORKER_CUTOVER_TIMEOUT');
}
async function waitApi(image,deadline) {
  while(Date.now()<deadline) {
    const list=await aws('ecs','list-service-deployments',{cluster:TARGET.cluster,service:TARGET.serviceName});
    const latest=[...(list.serviceDeployments??[])].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    check(latest?.serviceDeploymentArn,'API_DEPLOYMENT');
    const deployment=(await aws('ecs','describe-service-deployments',{serviceDeploymentArns:[latest.serviceDeploymentArn]})).serviceDeployments?.[0];
    if(deployment?.status==='ROLLBACK_SUCCESSFUL'||deployment?.status==='ROLLBACK_FAILED'||deployment?.status==='STOPPED')throw Error('RECOVERY_RELEASE_API_ROLLED_BACK');
    if(deployment?.status==='SUCCESSFUL') {
      const snapshot=await current();
      if(snapshot.api.meta.image===image){preserved(snapshot);return snapshot;}
    }
    await wait(10_000);
  }
  throw Error('RECOVERY_RELEASE_API_CUTOVER_TIMEOUT');
}
async function promote(profile) {
  if(profile==='candidate')check(state.migration?.finalLedger==='13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e','VERIFIED_MIGRATION_REQUIRED');
  let snapshot=await current();preserved(snapshot);
  if(profile==='fallback')verifyReleasePins(snapshot,state.expected);
  const review=createRecoveryRuntimeReview({snapshot,release:state.release,profile,expiresAt:expiry()});
  const observedProbes=await probes(snapshot,review);snapshot=await current();preserved(snapshot);
  const plan=createRecoveryRuntimePlan({snapshot,review,probes:observedProbes});await json('plan-'+profile,plan);
  const registered=await aws('ecs','register-task-definition',recoveryWorkerRegistration(plan));
  snapshot=await current();preserved(snapshot);
  await aws('ecs','update-service',recoveryWorkerUpdate({plan,registered,observation:snapshot.worker}));
  const deadline=Math.min(Date.parse(plan.preparedAt)+14*60_000,Date.parse(plan.expiresAt));
  await waitWorker(registered.taskDefinition.taskDefinitionArn,deadline);
  snapshot=await current();preserved(snapshot);
  await aws('ecs','update-express-gateway-service',recoveryApiUpdate({plan,workerObservation:snapshot.worker,apiObservation:{...snapshot.api,topology:snapshot.topology}}));
  const completed=await waitApi(plan.image,deadline);
  state[profile]={source:plan.source,image:plan.image,pins:releasePins(completed),completedAt:new Date().toISOString()};await save();
  await json(profile,{...state[profile],probeTasks:plan.probeTasks,probeReceiptsSha256:plan.probeReceiptsSha256,
    ledgerThrough:plan.ledgerThrough,configurationPreserved:true,featureActivation:false},true);
}
async function ownerTask(mode,review,inspection,rehearsal) {
  const snapshot=await observeOwner(input.owner);
  const request={mode,review,snapshot,...(inspection?{inspection}:{}),...(rehearsal?{rehearsal}:{})};
  const registered=await aws('ecs','register-task-definition',registerRecoveryOwner(request));
  const refreshed={...request,snapshot:await observeOwner(input.owner),registered};
  const launched=await aws('ecs','run-task',runRecoveryOwner(refreshed));
  check(!launched.failures?.length&&launched.tasks?.length===1,'OWNER_LAUNCH');
  await stopped([launched.tasks[0].taskArn]);
  let receipt;const deadline=Date.now()+45_000;
  while(!receipt) {
    try{receipt=collectTaskReceipt(launched.tasks[0].taskArn);}
    catch(error) {
      if(error.message!=='HOSTED_RECEIPT_ONE_COMPLETED_REPORT_REQUIRED'||Date.now()>=deadline)throw error;
      await wait(3_000);
    }
  }
  await json('owner-'+mode+'-'+(++sequence),receipt);return receipt;
}
async function rehearse() {
  const verified=verifyRecoveryRelease(state.release);
  check(state.expected.api.image===verified.fallback&&state.expected.worker.image===verified.fallback,'QUALIFIED_BRIDGE_REQUIRED');
  let snapshot=await observeOwner(input.owner);
  let review=createRecoveryOwnerReview({snapshot,release:state.release,expiresAt:expiry()});
  const inspection=await ownerTask('inspect',review);
  snapshot=await observeOwner(input.owner);
  review=createRecoveryOwnerReview({snapshot,release:state.release,expiresAt:expiry(),inspection});
  const rehearsal=await ownerTask('rehearse',review,inspection);
  // Reconstructing the apply registration verifies the actual stopped rehearsal
  // and its precise command. It does not execute or register an apply task.
  registerRecoveryOwner({mode:'apply',review,snapshot:await observeOwner(input.owner),inspection,rehearsal});
  await json('rehearsal',{source:input.source,reviewSha256:ownerDigest(review),expiresAt:review.expiresAt,
    inspection:inspection.task.taskArn,rehearsal:rehearsal.task.taskArn,rolledBack:true,
    initialLedger:rehearsal.report.initialLedger,finalLedger:rehearsal.report.finalLedger,completedAt:new Date().toISOString()},true);
}
async function apply() {
  const review=state.ownerReview,{inspection,rehearsal}=state.ownerReceipts;
  const confirmation=await ownerTask('apply',review,inspection,rehearsal);
  const postInspection=await ownerTask('inspect',review);
  state.migration=verifyRecoveryApplication({review,snapshot:await observeOwner(input.owner),inspection,rehearsal,confirmation,postInspection});await save();
  await json('migration',{...state.migration,ownerReceipts:{reviewSha256:ownerDigest(review),inspection:inspection.task.taskArn,
    rehearsal:rehearsal.task.taskArn,confirmation:confirmation.task.taskArn,postInspection:postInspection.task.taskArn},
    completedAt:new Date().toISOString(),historicalLedgerPreserved:true},true);
}
async function main() {
  const [phase,inputFile,output]=process.argv.slice(2);
  check(process.argv.length===5&&['policy-inspect','inspect','policy-hydrate','hydrate','policy-build','build','policy-runtime','fallback','policy-owner','rehearse','apply','candidate','policy-facility','facility-inspect'].includes(phase),'PHASE');
  input=JSON.parse(await readFile(inputFile,'utf8'));dir=resolve(output);evidence=join(dir,'receipts');
  await mkdir(dir,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true,mode:0o700});
  check(/^[a-f0-9]{40}$/.test(input.source??'')&&recoveryPhases.includes(input.phase),'INPUT');
  authorizeCoordinatorPhase(phase,input.phase);
  check(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REF==='refs/heads/main'&&process.env.GITHUB_REPOSITORY==='thepackproof/packproof-v2','MAIN_OIDC_ONLY');
  check(command('git',['cat-file','-t',input.source]).trim()==='commit','SOURCE_COMMIT');
  command('git',['merge-base','--is-ancestor',input.source,process.env.GITHUB_SHA]);
  if(input.phase==='facility-inspect') {
    const ci=input.ci;
    check(ci?.repository?.full_name==='thepackproof/packproof-v2'&&ci.name==='CI'&&ci.path==='.github/workflows/ci.yml'&&
      ci.head_sha===input.source&&ci.head_branch==='main'&&['push','workflow_dispatch'].includes(ci.event)&&
      ci.status==='completed'&&ci.conclusion==='success','FACILITY_SOURCE_CI');
    for(const name of ['logistics-facility-inspect.mjs','recovery-facility-inspection.mjs']) {
      const path='infra/backend-release/'+name;
      check(sha(command('git',['show',input.source+':'+path]))===sha(await readFile(join(root,path))),'FACILITY_REVIEWED_CODE_CHANGED');
    }
  }
  if(!['policy-inspect','inspect'].includes(phase)) {
    state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));check(state.source===input.source,'STATE_SOURCE');
  }
  if(phase.startsWith('policy-')) {
    check(process.env.GITHUB_OUTPUT,'OUTPUT');
    const policy=recoverySessionPolicy(phase.slice(7),{source:input.source,snapshot:state?.snapshot,owner:state?.owner,runId:process.env.GITHUB_RUN_ID});
    await appendFile(process.env.GITHUB_OUTPUT,'policy='+policy+'\n');return;
  }
  const identity=await aws('sts','get-caller-identity');
  check(identity.Account===TARGET.account&&identity.Arn?.startsWith('arn:aws:sts::'+TARGET.account+':assumed-role/PackProofGitHubDeploy/'),'OIDC_PRINCIPAL');
  if(phase==='inspect')await inspect();
  else if(phase==='facility-inspect')await inspectFacility();
  else if(phase==='build')await build();
  else if(phase==='hydrate')await hydrate();
  else if(phase==='rehearse')await rehearse();
  else if(phase==='apply')await apply();
  else await promote(phase);
  console.log(JSON.stringify({phase,source:input.source,completed:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(async error=>{
  const code=safeCode(error);if(evidence)await json('failure',{code,source:input?.source,automaticRollback:false},true);
  console.error(code);process.exitCode=1;
});
