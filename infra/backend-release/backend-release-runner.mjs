/** Release phase coordinator. Requires reviewed exact source and live topology. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TARGET,hash,makePlan} from './backend-deployment-plan.mjs';
import {buildRequest,verifierTaskDefinition,runVerifierRequest,preservationSnapshot} from './backend-release-requests.mjs';
import {sessionPolicy} from './backend-release-session-policies.mjs';
import {serviceWithRevision,awsFailureCode} from '../backend-service-state.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const phase=process.argv[2],inputFile=process.argv[3];
const endpoint='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const check=(v,code)=>{if(!v)throw Error(code);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let privateDir,evidenceDir,input,state,receipt={};
async function json(file,value){await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function save(){await json(path.join(privateDir,'state.json'),state);}
function git(...args){return execFileSync('git',args,{maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});}
function aws(service,operation,args=[]){try{return JSON.parse(execFileSync('aws',[service,operation,...args,'--region',TARGET.region,'--output','json','--no-cli-pager'],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,stdio:['ignore','pipe','pipe']}));}catch(error){throw Error(`AWS_${service}_${operation}_${awsFailureCode(error)}`.replaceAll(/[^A-Za-z0-9_]/g,'_').toUpperCase());}}
async function send(service,operation,request){const file=path.join(privateDir,`${service}-${operation}.json`);await json(file,request);return aws(service,operation,['--cli-input-json',`file://${file}`]);}
async function publicJson(route){const response=await fetch(endpoint+route,{headers:{Origin:'https://thepackproof.com','Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});return{status:response.status,cors:response.headers.get('access-control-allow-origin'),body:await response.json()};}
function selectCurrentDeployment(list){return [...list].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];}
async function baseline({duringRollout=false}={}){
 let service=aws('ecs','describe-services',['--cluster',TARGET.cluster,'--services',TARGET.serviceName]).services?.[0];
 check(service?.serviceArn===TARGET.serviceArn,'SERVICE_MISMATCH');
 const express=aws('ecs','describe-express-gateway-service',['--service-arn',TARGET.serviceArn]).service;
 check(express?.activeConfigurations?.length>=1&&(duringRollout||express.activeConfigurations.length===1),'AMBIGUOUS_EXPRESS_CONFIGURATION');
 const native=selectCurrentDeployment(aws('ecs','list-service-deployments',['--cluster',TARGET.cluster,'--service',TARGET.serviceName]).serviceDeployments??[]);
 const revisionArn=express.activeConfigurations.length===1?express.activeConfigurations[0].serviceRevisionArn:native?.targetServiceRevisionArn;
 check(revisionArn&&express.activeConfigurations.some(c=>c.serviceRevisionArn===revisionArn),'CURRENT_SERVICE_REVISION_UNAVAILABLE');
 const revisions=aws('ecs','describe-service-revisions',['--service-revision-arns',revisionArn]).serviceRevisions;
 check(revisions?.length===1&&revisions[0].serviceRevisionArn===revisionArn,'CURRENT_SERVICE_REVISION_MISMATCH');
 service=serviceWithRevision(service,revisions[0]);
 const taskDefinition=aws('ecs','describe-task-definition',['--task-definition',service.taskDefinition]).taskDefinition;
 const meta=await publicJson('/meta');check(meta.status===200&&meta.cors==='https://thepackproof.com','PUBLIC_META_UNAVAILABLE');
 const deployment=native?.serviceDeploymentArn?aws('ecs','describe-service-deployments',['--service-deployment-arns',native.serviceDeploymentArn]).serviceDeployments?.[0]:null;
 return{account:TARGET.account,region:TARGET.region,service,express,taskDefinition,nativeDeploymentStatus:deployment?.status,nativeDeploymentArn:native?.serviceDeploymentArn,nativeDeployment:deployment,meta:meta.body};
}
async function topology(){
 // Reuse the committed whitelisted discovery helper. Optional denied IAM reads
 // are not topology passes; every topology API below must actually succeed.
 const file=path.join(privateDir,`topology-${Date.now()}.json`);
 execFileSync(process.execPath,[path.join(here,'../backend-control-plane-readonly.mjs'),file],{timeout:10*60*1000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 const value=JSON.parse(await readFile(file,'utf8'));
 for(const operation of ['describe-express-gateway-service','describe-target-groups','describe-load-balancers','describe-load-balancer-attributes','describe-security-groups','describe-subnets'])check(value.calls.some(x=>x.operation===operation&&x.status==='SUCCESS'),'TOPOLOGY_READ_INCOMPLETE');
 const proxies=value.express.activeConfigurations[0].primaryContainer.trustedProxies;
 check(proxies.configured===true&&typeof proxies.value==='string'&&proxies.value.trim(),'TRUSTED_PROXY_REVIEW_REQUIRED');
 const shape={trustedProxies:proxies,loadBalancers:value.loadBalancers,targetGroups:value.targetGroups,securityGroups:value.securityGroups,subnets:value.subnets};
 check(hash(shape)===input.expectedTopologySha256,'TOPOLOGY_APPROVAL_OR_DRIFT_MISMATCH');
 return{sha256:hash(shape),observedAt:value.observedAt};
}
function inventory(source){
 const names=git('ls-tree','--name-only',`${source}:backend/migrations`).toString().trim().split('\n').filter(x=>x.endsWith('.sql')).sort();
 return names.map(name=>({id:name.slice(0,-4),checksum:sha(git('show',`${source}:backend/migrations/${name}`))}));
}
async function verifyPredecessor(value){
 check(value.service.taskDefinition===input.expectedPreviousTaskDefinition&&value.meta.image===input.expectedPreviousImage,'PREDECESSOR_CHANGED');
 check(value.nativeDeploymentStatus==='SUCCESSFUL'&&value.service.desiredCount>=1&&value.service.runningCount===value.service.desiredCount&&value.service.pendingCount===0,'PREDECESSOR_NOT_STABLE');
 const c=value.express.activeConfigurations[0].primaryContainer,env=Object.fromEntries((c.environment??[]).map(x=>[x.name,x.value]));
 check(c.image===value.meta.image&&env.PACKPROOF_RELEASE_SHA===value.meta.commit&&env.PACKPROOF_RELEASE_IMAGE===value.meta.image&&env.PACKPROOF_MIGRATE_ON_START==='false','PREDECESSOR_CONFIGURATION_MISMATCH');
 const keys=[...(c.environment??[]),...(c.secrets??[])].map(x=>x.name);check(keys.length===new Set(keys).size,'DUPLICATE_BINDINGS');
 const running=aws('ecs','list-tasks',['--cluster',TARGET.cluster,'--service-name',TARGET.serviceName,'--desired-status','RUNNING']).taskArns??[];
 check(running.length===value.service.desiredCount,'RUNNING_TASK_COUNT_MISMATCH');
 const tasks=aws('ecs','describe-tasks',['--cluster',TARGET.cluster,'--tasks',...running]).tasks??[];
 check(tasks.length===running.length&&tasks.every(t=>t.taskDefinitionArn===value.service.taskDefinition&&t.lastStatus==='RUNNING'&&t.containers?.length===1&&t.containers[0].imageDigest===input.expectedPreviousImage.split('@')[1]),'RUNNING_PREDECESSOR_DIGEST_MISMATCH');
}
async function build(){
 state={sourceSha:input.sourceSha,runId:process.env.GITHUB_RUN_ID,baseline:await baseline()};
 await verifyPredecessor(state.baseline);state.topology=await topology();
 const project=aws('codebuild','batch-get-projects',['--names',TARGET.serviceName]).projects?.[0];
 check(project?.source?.type==='S3'&&project.environment?.privilegedMode===true,'EXISTING_BUILD_PROJECT_MISMATCH');
 const db=aws('rds','describe-db-instances',['--db-instance-identifier','packproof-v2-staging-db']).DBInstances?.[0];
 check(db?.DBInstanceStatus==='available'&&db.BackupRetentionPeriod>0&&db.LatestRestorableTime,'DATABASE_RECOVERY_UNAVAILABLE');
 state.recovery={latestRestorableTime:db.LatestRestorableTime,backupRetentionDays:db.BackupRetentionPeriod};
 const rows=inventory(input.sourceSha);check(rows.length===76&&hash(rows)===hash(inventory(state.baseline.meta.commit)),'MIGRATION_SOURCE_DELTA_REQUIRES_REVIEW');
 state.inventorySha256=sha(JSON.stringify(rows));state.preservation=preservationSnapshot(state.baseline);
 const previous=aws('ecr','batch-get-image',['--repository-name',TARGET.serviceName,'--image-ids',`imageDigest=${input.expectedPreviousImage.split('@')[1]}`]);check(previous.images?.length===1&&!previous.failures?.length,'ROLLBACK_IMAGE_UNAVAILABLE');
 const images=aws('ecr','describe-images',['--repository-name',TARGET.serviceName]).imageDetails??[];
 check(!images.some(x=>x.imageTags?.includes(`security-${input.sourceSha}`)),'CANDIDATE_TAG_ALREADY_EXISTS');
 const lifecycle=JSON.parse(aws('ecr','get-lifecycle-policy',['--repository-name',TARGET.serviceName]).lifecyclePolicyText);
 // This guard deliberately supports only the previously recorded last-five rule.
 // Adapt after discovery if the real policy differs; never rewrite it automatically.
 check(lifecycle.rules?.length===1&&lifecycle.rules[0].selection?.tagStatus==='any'&&lifecycle.rules[0].selection?.countType==='imageCountMoreThan'&&lifecycle.rules[0].action?.type==='expire','UNREVIEWED_ECR_RETENTION_POLICY');
 const ordered=[...images].sort((a,b)=>Date.parse(b.imagePushedAt)-Date.parse(a.imagePushedAt));
 const position=ordered.findIndex(x=>x.imageDigest===input.expectedPreviousImage.split('@')[1]);
 check(position>=0&&position+2<=lifecycle.rules[0].selection.countNumber,'ROLLBACK_RETENTION_REVIEW_REQUIRED');
 const zip=path.join(privateDir,'backend.zip');git('archive','--format=zip',`--output=${zip}`,`${input.sourceSha}:backend`);
 const bytes=await readFile(zip),zipSha256=sha(bytes),bucket=`packproof-v2-staging-build-${TARGET.account}`,key=`security-release/${input.sourceSha}/${zipSha256}/backend.zip`;
 const uploaded=aws('s3api','put-object',['--bucket',bucket,'--key',key,'--body',zip,'--if-none-match','*','--checksum-sha256',createHash('sha256').update(bytes).digest('base64')]);
 const head=aws('s3api','head-object',['--bucket',bucket,'--key',key,'--checksum-mode','ENABLED',...(uploaded.VersionId&&uploaded.VersionId!=='null'?['--version-id',uploaded.VersionId]:[])]);
 check(head.ContentLength===bytes.length&&head.ChecksumSHA256===createHash('sha256').update(bytes).digest('base64'),'SOURCE_UPLOAD_CHECKSUM_MISMATCH');
 state.archive={key,sha256:zipSha256,bytes:bytes.length,...(uploaded.VersionId&&uploaded.VersionId!=='null'?{version:uploaded.VersionId}:{})};
 const buildspec=await readFile(path.join(here,'backend-scoped-buildspec.yml'),'utf8');
 const request=buildRequest({sourceSha:input.sourceSha,zipSha256,sourceVersion:state.archive.version,buildspec});
 const started=await send('codebuild','start-build',request);state.buildId=started.build?.id;check(state.buildId,'BUILD_ID_MISSING');await save();
 const deadline=Date.now()+40*60*1000;let finished;
 do{const b=aws('codebuild','batch-get-builds',['--ids',state.buildId]).builds?.[0];check(b?.source?.location===request.sourceLocationOverride,'BUILD_SOURCE_MISMATCH');if(b.buildStatus!=='IN_PROGRESS'){finished=b;break;}console.log(JSON.stringify({phase:'build',status:b.buildStatus,currentPhase:b.currentPhase}));await sleep(30000);}while(Date.now()<deadline);
 check(finished?.buildStatus==='SUCCEEDED','BUILD_NOT_SUCCEEDED');
 const built=aws('ecr','batch-get-image',['--repository-name',TARGET.serviceName,'--image-ids',`imageTag=security-${input.sourceSha}`]);
 check(built.images?.length===1&&!built.failures?.length,'CANDIDATE_IMAGE_MISSING');
 state.image=`${TARGET.repository}@${built.images[0].imageId.imageDigest}`;state.buildSucceeded=true;await save();
 receipt={phase:'build',sourceSha:input.sourceSha,image:state.image,buildId:state.buildId,sourceArchive:state.archive,sourceInventorySha256:state.inventorySha256,preservation:state.preservation,recovery:state.recovery,topology:state.topology,rollbackImage:input.expectedPreviousImage,previousTaskDefinition:input.expectedPreviousTaskDefinition};
}
async function preflight(){
 check(state.buildSucceeded===true,'BUILD_GATE_REQUIRED');const live=await baseline();await verifyPredecessor(live);check(hash(preservationSnapshot(live))===hash(state.preservation),'RUNTIME_DRIFT');
 const script=await readFile(path.join(here,'backend-database-preflight.mjs'),'utf8');
 const prepared=verifierTaskDefinition(live.taskDefinition,{sourceSha:input.sourceSha,image:state.image,version:input.version,script,inventorySha256:state.inventorySha256,runId:state.runId});
 const definition=(await send('ecs','register-task-definition',prepared.request)).taskDefinition?.taskDefinitionArn;check(definition,'VERIFIER_REGISTRATION_FAILED');state.verifierDefinition=definition;await save();
 let taskArn,stopped=false;
 try{
  const launched=await send('ecs','run-task',runVerifierRequest(live.service,definition,{sourceSha:input.sourceSha,runId:state.runId}));
  check(!launched.failures?.length&&launched.tasks?.length===1,'VERIFIER_LAUNCH_FAILED');taskArn=launched.tasks[0].taskArn;state.verifierTaskArn=taskArn;await save();
  const deadline=Date.now()+10*60*1000;let task;
  do{task=aws('ecs','describe-tasks',['--cluster',TARGET.cluster,'--tasks',taskArn]).tasks?.[0];if(task?.lastStatus==='STOPPED'){stopped=true;break;}await sleep(15000);}while(Date.now()<deadline);
  check(stopped&&task.taskDefinitionArn===definition&&task.containers?.length===1&&task.containers[0].imageDigest===state.image.split('@')[1],'VERIFIER_TASK_IDENTITY_UNAVAILABLE');
  const stream=`${prepared.logPrefix}/${prepared.containerName}/${taskArn.split('/').at(-1)}`;
  let record;for(let attempt=0;attempt<5&&!record;attempt++){
   const events=aws('logs','get-log-events',['--log-group-name',prepared.logGroup,'--log-stream-name',stream,'--start-from-head']).events??[];
   for(const event of events){try{const value=JSON.parse(event.message);if(['security_release_database_preflight','security_release_database_preflight_failed'].includes(value.event))record=value;}catch{}}
   if(!record)await sleep(5000);
  }
  if(record?.event==='security_release_database_preflight_failed')throw Error(record.code==='ONBOARDING_MIGRATION_REQUIRED'?'VERIFIER_ONBOARDING_MIGRATION_REQUIRED':'VERIFIER_DATABASE_REVIEW_REQUIRED');
  check(task.containers[0].exitCode===0&&record?.sourceSha===input.sourceSha&&record.readOnly===true&&record.sourceInventorySha256===state.inventorySha256&&record.runtimeAuthorityUnchanged===true&&record.durabilityPolicyMatches===true,'VERIFIER_RECEIPT_MISSING');
  state.databaseReceipt=record;state.databasePreflightPassed=true;await save();receipt={phase:'preflight',sourceSha:input.sourceSha,image:state.image,taskArn,taskDefinition:definition,scriptSha256:prepared.scriptSha256,receipt:record};
 }finally{
  if(taskArn&&!stopped){await send('ecs','stop-task',{cluster:TARGET.cluster,task:taskArn,reason:'Bounded read-only release verifier cleanup'});}
  await send('ecs','deregister-task-definition',{taskDefinition:definition});
 }
}
async function deploy(){
 check(state.databasePreflightPassed===true,'DATABASE_GATE_REQUIRED');const live=await baseline();await verifyPredecessor(live);await topology();check(hash(preservationSnapshot(live))===hash(state.preservation),'RUNTIME_DRIFT');
 const plan=makePlan(live,{sourceSha:input.sourceSha,image:state.image,version:input.version,expectedPreviousImage:input.expectedPreviousImage,expectedPreviousTaskDefinition:input.expectedPreviousTaskDefinition,ciPassed:true,databasePreflightPassed:true,sourceArchiveVerified:state.buildSucceeded===true});
 state.updateAttempted=true;await save();
 const result=await send('ecs','update-express-gateway-service',plan.update);check(result.service?.serviceArn===TARGET.serviceArn,'UPDATE_ACKNOWLEDGEMENT_MISSING');
 state.updateSubmitted=true;await save();let completed,current;
 const deadline=Date.now()+40*60*1000;
 do{
  current=await baseline({duringRollout:true});const primary=current.express.activeConfigurations.find(c=>c.primaryContainer?.image===state.image);
  if(current.nativeDeploymentStatus==='ROLLBACK_SUCCESSFUL'||current.nativeDeploymentStatus==='STOPPED')throw Error('NATIVE_ROLLOUT_REQUIRES_REVIEW');
  if(primary&&current.nativeDeploymentStatus==='SUCCESSFUL'&&current.nativeDeploymentArn!==live.nativeDeploymentArn&&current.nativeDeployment?.targetServiceRevision?.requestedProductionTrafficWeight===100&&current.service.pendingCount===0&&current.service.runningCount===current.service.desiredCount&&current.meta.commit===input.sourceSha&&current.meta.image===state.image&&current.express.activeConfigurations.length===1){completed=true;break;}
  console.log(JSON.stringify({phase:'deploy',nativeStatus:current.nativeDeploymentStatus,running:current.service.runningCount,pending:current.service.pendingCount}));await sleep(30000);
 }while(Date.now()<deadline);
 check(completed,'ROLLOUT_NOT_COMPLETED');
 check(hash(preservationSnapshot(current))===hash(state.preservation),'POST_DEPLOY_PRESERVATION_MISMATCH');
 const taskArns=aws('ecs','list-tasks',['--cluster',TARGET.cluster,'--service-name',TARGET.serviceName,'--desired-status','RUNNING']).taskArns??[];
 const tasks=taskArns.length?aws('ecs','describe-tasks',['--cluster',TARGET.cluster,'--tasks',...taskArns]).tasks??[]:[];
 check(tasks.length===current.service.desiredCount&&tasks.every(t=>t.taskDefinitionArn===current.service.taskDefinition&&t.containers?.length===1&&t.containers[0].imageDigest===state.image.split('@')[1]),'FINAL_TASK_DIGEST_MISMATCH');
 const health=await publicJson('/health'),ready=await publicJson('/ready'),auth=await publicJson('/me/capabilities');
 check(health.status===200&&ready.status===200&&auth.status===401&&[health,ready,auth].every(x=>x.cors==='https://thepackproof.com'),'PUBLIC_POSTCHECK_FAILED');
 receipt={phase:'deploy',sourceSha:input.sourceSha,image:state.image,taskDefinition:current.service.taskDefinition,nativeDeploymentArn:current.nativeDeploymentArn,nativeStatus:current.nativeDeploymentStatus,desiredCount:current.service.desiredCount,preservation:preservationSnapshot(current),meta:current.meta,http:{health:health.status,ready:ready.status,unauthenticatedCapabilities:auth.status},rollbackImage:input.expectedPreviousImage,customerFlows:'NOT_EXERCISED'};
}
async function main(){
 check(['policy-build','policy-preflight','policy-deploy','build','preflight','deploy'].includes(phase)&&inputFile,'EXPECTED_PHASE_AND_INPUT');
 input=JSON.parse(await readFile(inputFile,'utf8'));
 check(process.env.GITHUB_REPOSITORY==='thepackproof/packproof-v2'&&process.env.GITHUB_REF==='refs/heads/main'&&input.sourceSha===process.env.GITHUB_SHA&&/^[a-f0-9]{40}$/.test(input.sourceSha),'EXACT_MAIN_GITHUB_RUN_REQUIRED');
 check(git('rev-parse','HEAD').toString().trim()===input.sourceSha&&git('status','--porcelain').toString().trim()==='','CLEAN_SOURCE_REQUIRED');
 check(input.ciPassed===true&&/^[a-f0-9]{64}$/.test(input.expectedTopologySha256)&&/^\S+@sha256:[a-f0-9]{64}$/.test(input.expectedPreviousImage)&&/^arn:aws:ecs:us-east-1:784514617543:task-definition\//.test(input.expectedPreviousTaskDefinition)&&/^[A-Za-z0-9._-]{1,100}$/.test(input.version),'REVIEWED_INPUTS_REQUIRED');
 privateDir=path.join(process.env.RUNNER_TEMP,'packproof-backend-private');evidenceDir=path.join(process.env.RUNNER_TEMP,'packproof-backend-evidence');await mkdir(privateDir,{recursive:true,mode:0o700});await mkdir(evidenceDir,{recursive:true,mode:0o700});
 if(!['policy-build','build'].includes(phase)){state=JSON.parse(await readFile(path.join(privateDir,'state.json'),'utf8'));check(state.sourceSha===input.sourceSha&&state.runId===process.env.GITHUB_RUN_ID,'PRIVATE_STATE_IDENTITY_MISMATCH');}
 if(phase.startsWith('policy-')){
  const task=state?.baseline.taskDefinition,express=state?.baseline.express;
  const policy=sessionPolicy(phase.slice(7),{sourceSha:input.sourceSha,taskRoleArn:task?.taskRoleArn,executionRoleArn:task?.executionRoleArn,infrastructureRoleArn:express?.infrastructureRoleArn,apiTaskFamily:task?.family,logGroup:task?.containerDefinitions?.[0]?.logConfiguration?.options?.['awslogs-group']});
  check(process.env.GITHUB_OUTPUT,'GITHUB_OUTPUT_REQUIRED');await appendFile(process.env.GITHUB_OUTPUT,`policy=${policy}\n`);return;
 }
 const identity=aws('sts','get-caller-identity');check(identity.Account===TARGET.account&&identity.Arn?.startsWith(`arn:aws:sts::${TARGET.account}:assumed-role/PackProofGitHubDeploy/`),'EXPECTED_OIDC_PRINCIPAL_REQUIRED');
 await({build,preflight,deploy}[phase])();await json(path.join(evidenceDir,`${phase}.json`),{...receipt,completedAt:new Date().toISOString()});
 console.log(JSON.stringify({phase,sourceSha:input.sourceSha,completed:true}));
}
main().catch(async error=>{const code=/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'RELEASE_PHASE_FAILED';if(evidenceDir)await json(path.join(evidenceDir,`${phase}-failure.json`),{phase,sourceSha:input?.sourceSha,code,updateAttempted:state?.updateAttempted===true,updateAcknowledged:state?.updateSubmitted===true,automaticRollbackRequested:false});console.error(code);process.exitCode=1;});
