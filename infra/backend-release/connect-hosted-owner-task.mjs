// Build private ECS requests for an isolated, one-shot Connect migration process.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {serviceWithRevision} from '../backend-service-state.mjs';
import {pathToFileURL} from 'node:url';
import {TARGET,hash} from './backend-deployment-plan.mjs';
import {reconstructionDigest,hostedCollectorTarget as target} from './reconstruction-v11-release-review.mjs';
import {validateOwnerReview} from './connect-hosted-migration.mjs';

const account=TARGET.account, region=TARGET.region, worker='packproof-records-worker';
const roleName='packproof-connect-hosted-owner-execution';
const roleArn='arn:aws:iam::'+account+':role/'+roleName;
const existingRole='arn:aws:iam::'+account+':role/packproof-v2-staging-execution';
const logGroup='/ecs/packproof-v2-staging-api', stream='connect-hosted-owner';
const cluster=target.clusterArn, imagePrefix=TARGET.repository+'@sha256:';
const allowedImage=v=>typeof v==='string'&&v.startsWith(imagePrefix)&&/^[a-f0-9]{64}$/.test(v.slice(imagePrefix.length));
const check=(value,code)=>{if(!value)throw Error('OWNER_TASK_'+code);};
const sorted=values=>[...values].sort();
const same=(a,b)=>hash(a)===hash(b);
const env=c=>Object.fromEntries((c.environment??[]).map(x=>[x.name,x.value]));
const taskPrefix=cluster.replace(':cluster/',':task/')+'/';
const taskId=s=>typeof s==='string'&&s.startsWith(taskPrefix)&&/^[a-f0-9]{32}$/.test(s.slice(taskPrefix.length));
const secretPattern=/^arn:aws:secretsmanager:us-east-1:784514617543:secret:rds!db-[0-9a-f-]{36}-[A-Za-z0-9]{6}$/;
const kmsPattern=/^arn:aws:kms:us-east-1:784514617543:key\/[0-9a-f-]{36}$/;

function validateDatabase(d) {
  check(d?.DBInstanceIdentifier==='packproof-v2-staging-db'&&d.DBInstanceStatus==='available'&&d.Engine==='postgres'&&
    /^16\./.test(d.EngineVersion)&&d.Endpoint?.Address===target.host&&d.Endpoint?.Port===5432&&d.DBName===target.database&&
    d.MasterUsername==='packproof'&&d.PubliclyAccessible===false&&d.StorageEncrypted===true&&
    d.MasterUserSecret?.SecretStatus==='active'&&secretPattern.test(d.MasterUserSecret.SecretArn),'DATABASE_METADATA');
  return d.MasterUserSecret.SecretArn;
}
export function ownerExecutionRoleTemplate(db) {
  const secretArn=validateDatabase(db), kms=db.MasterUserSecret.KmsKeyId;
  const assume={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ecs-tasks.amazonaws.com'},
    Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account},
      ArnLike:{'aws:SourceArn':'arn:aws:ecs:'+region+':'+account+':*'}}}]};
  const statements=[
    {Effect:'Allow',Action:'ecr:GetAuthorizationToken',Resource:'*'},
    {Effect:'Allow',Action:['ecr:BatchCheckLayerAvailability','ecr:GetDownloadUrlForLayer','ecr:BatchGetImage'],
      Resource:'arn:aws:ecr:'+region+':'+account+':repository/'+TARGET.serviceName},
    {Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],
      Resource:'arn:aws:logs:'+region+':'+account+':log-group:'+logGroup+':log-stream:'+stream+'/*'},
    {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:secretArn},
  ];
  if(kms) {
    check(kmsPattern.test(kms)||/^[a-f0-9-]{36}$/.test(kms),'KMS_KEY');
    const key=kmsPattern.test(kms)?kms:'arn:aws:kms:'+region+':'+account+':key/'+kms;
    statements.push({Effect:'Allow',Action:'kms:Decrypt',Resource:key,Condition:{StringEquals:{
      'kms:ViaService':'secretsmanager.'+region+'.amazonaws.com','kms:EncryptionContext:SecretARN':secretArn}}});
  }
  return {AWSTemplateFormatVersion:'2010-09-09',Resources:{OwnerExecution:{Type:'AWS::IAM::Role',Properties:{
    RoleName:roleName,AssumeRolePolicyDocument:assume,Policies:[{PolicyName:'RunOwnerOnly',
      PolicyDocument:{Version:'2012-10-17',Statement:statements}}]}}},Outputs:{RoleArn:{Value:{'Fn::GetAtt':['OwnerExecution','Arn']}}}};
}

export function verifyService(observation, kind, expected, bridge) {
  const {service,taskDefinition:td,tasks}=observation;
  const name=kind==='api'?TARGET.serviceName:worker;
  const serviceArn=cluster.replace(':cluster/',':service/')+'/'+name;
  check(service?.serviceArn===serviceArn&&service.clusterArn===cluster&&service.status==='ACTIVE'&&
    Number.isInteger(service.desiredCount)&&service.desiredCount>=1&&service.runningCount===service.desiredCount&&
    service.pendingCount===0&&td?.status==='ACTIVE'&&service.taskDefinition===td.taskDefinitionArn&&
    td.networkMode==='awsvpc'&&td.requiresCompatibilities?.includes('FARGATE'),'UNSTABLE_'+kind.toUpperCase());
  if(kind==='api') {
    const config=observation.express?.activeConfigurations;
    check(observation.nativeDeploymentStatus==='SUCCESSFUL'&&observation.express.serviceArn===serviceArn&&
      config?.length===1&&config[0].primaryContainer?.image===expected.image&&observation.meta?.image===expected.image&&
      observation.meta.commit===expected.source,'API_TRAFFIC_OR_IDENTITY');
  }else check(service.deployments?.length===1&&service.deployments[0].status==='PRIMARY'&&
    service.deployments[0].rolloutState==='COMPLETED'&&service.deployments[0].taskDefinition===td.taskDefinitionArn,'WORKER_ROLLOUT');
  const definitions=td.containerDefinitions, primaries=definitions.filter(c=>env(c).PACKPROOF_PROCESS_ROLE===kind);
  check(primaries.length===1&&definitions.every(c=>c.image===expected.image),'SERVICE_DEFINITION_IMAGE');
  const primary=primaries[0], e=env(primary);
  check(e.PACKPROOF_RELEASE_SHA===expected.source&&e.PACKPROOF_RELEASE_IMAGE===expected.image&&
    e.PACKPROOF_ENVIRONMENT==='production'&&e.PACKPROOF_MIGRATE_ON_START==='false'&&e.PACKPROOF_DB_HOST===target.host&&
    e.PACKPROOF_DB_NAME===target.database&&(!bridge||!e.PACKPROOF_ORDER_WORKSPACE_ENABLED||e.PACKPROOF_ORDER_WORKSPACE_ENABLED==='false'),'SERVICE_BINDING');
  check(tasks?.length===service.desiredCount&&new Set(tasks.map(t=>t.taskArn)).size===tasks.length&&tasks.every(t=>
    taskId(t.taskArn)&&t.group==='service:'+name&&t.clusterArn===cluster&&t.taskDefinitionArn===td.taskDefinitionArn&&
    t.lastStatus==='RUNNING'&&t.desiredStatus==='RUNNING'&&t.healthStatus!=='UNHEALTHY'&&
    same(sorted(t.containers.map(c=>c.name)),sorted(definitions.map(c=>c.name)))&&t.containers.every(c=>
      c.imageDigest===expected.image.split('@')[1]&&
      (c.name===primary.name?c.lastStatus==='RUNNING'&&c.healthStatus!=='UNHEALTHY':c.lastStatus==='STOPPED'&&c.exitCode===0))),'LIVE_SERVICE_TASKS');
}

export function ownerSecurityGroupTemplate(db) {
  validateDatabase(db);
  const groups=db.VpcSecurityGroups?.filter(g=>g.Status==='active');
  check(/^vpc-[0-9a-f]+$/.test(db.DBSubnetGroup?.VpcId)&&groups?.length>0,'DATABASE_NETWORK');
  return {AWSTemplateFormatVersion:'2010-09-09',Resources:{OwnerNetwork:{Type:'AWS::EC2::SecurityGroup',Properties:{
    GroupDescription:'One-shot PackProof Connect owner tasks',VpcId:db.DBSubnetGroup.VpcId,SecurityGroupIngress:[],
    SecurityGroupEgress:[{IpProtocol:'tcp',FromPort:443,ToPort:443,CidrIp:'0.0.0.0/0'},
      ...groups.map(g=>({IpProtocol:'tcp',FromPort:5432,ToPort:5432,DestinationSecurityGroupId:g.VpcSecurityGroupId}))]}}},
    Outputs:{SecurityGroupId:{Value:{'Fn::GetAtt':['OwnerNetwork','GroupId']}}}};
}

function cidrRange(value) {
  const parts=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if(!parts||parts.slice(1,5).some(x=>Number(x)>255)||Number(parts[5])>32)return null;
  const mask=2**(32-Number(parts[5])),ip=parts.slice(1,5).reduce((n,v)=>256*n+Number(v),0);
  return [Math.floor(ip/mask)*mask,Math.floor(ip/mask)*mask+mask-1];
}
function subnetWithin(subnet,range) {
  const small=cidrRange(subnet),big=cidrRange(range);
  return small&&big&&small[0]>=big[0]&&small[1]<=big[1];
}
function allowsPort(permission,port) {
  return permission.IpProtocol==='-1'||permission.IpProtocol==='tcp'&&permission.FromPort<=port&&permission.ToPort>=port;
}
const asArray=x=>Array.isArray(x)?x:[x];
function validateExistingRole(iam,results,secret) {
  const trust=asArray(iam.AssumeRolePolicyDocument?.Statement);
  check(trust.some(s=>s?.Effect==='Allow'&&asArray(s.Action).includes('sts:AssumeRole')&&
    asArray(s.Principal?.Service).some(principal=>principal==='ecs-tasks.amazonaws.com')),'EXISTING_ECS_TRUST');
  check(results?.length===1&&results[0].EvalActionName?.toLowerCase()==='secretsmanager:getsecretvalue'&&
    results[0].EvalResourceName===secret&&results[0].EvalDecision==='allowed'&&!(results[0].MissingContextValues?.length),'EXISTING_OWNER_SECRET_ACCESS');
}

function acceptableIngress(group) {
  const rules=group?.IpPermissions;
  if(!Array.isArray(rules))return false;
  if(!rules.length)return true;
  // This existing VPC has no NAT. The service SG permits just its ALB to reach
  // the API port. The standalone migration process has no listener, mapping,
  // target-group attachment, service or operator-supplied container command.
  const p=rules[0], peers=p.UserIdGroupPairs;
  return group.GroupId==='sg-0fbfe8871eef85488'&&group.VpcId==='vpc-0bbe45c201fdf625d'&&rules.length===1&&
    p.IpProtocol==='tcp'&&p.FromPort===3000&&p.ToPort===3000&&
    !p.IpRanges?.length&&!p.Ipv6Ranges?.length&&!p.PrefixListIds?.length&&peers?.length===1&&
    peers[0].GroupId==='sg-0803f8500e439f39b'&&peers[0].UserId===account;
}
function verifyObservation(input, now) {
  const {snapshot:s,review:r,mode}=input, launch=r.ownerLaunch;
  const age=now.getTime()-Date.parse(s?.observedAt);
  check(age>=0&&age<=300000&&s.account===account&&s.region===region,'FRESH_TARGET_REQUIRED');
  const secret=validateDatabase(s.database);
  check(r.ownerRole===s.database.MasterUsername&&[roleArn,existingRole].includes(launch?.executionRoleArn)&&launch.ownerSecretArn===secret&&
    typeof launch.roleId==='string'&&/^AROA[0-9A-Z]{17}$/.test(launch.roleId)&&
    typeof launch.secretVersion==='string'&&/^[0-9a-zA-Z-]{32,64}$/.test(launch.secretVersion),'OWNER_PINS');
  const iam=s.ownerRole, expected=ownerExecutionRoleTemplate(s.database).Resources.OwnerExecution.Properties;
  check(iam?.Arn===launch.executionRoleArn&&iam.RoleId===launch.roleId,'EXECUTION_ROLE_IDENTITY');
  if(iam.Arn===existingRole)validateExistingRole(iam,s.ownerSecretSimulation,secret);
  else check(same(iam.AssumeRolePolicyDocument,expected.AssumeRolePolicyDocument)&&
    same(s.ownerAttachedPolicies,[])&&same(s.ownerInlinePolicyNames,['RunOwnerOnly'])&&
    same(s.ownerInlinePolicy,expected.Policies[0].PolicyDocument),'DEDICATED_EXECUTION_AUTHORITY');
  check(s.secretMetadata?.ARN===secret&&!s.secretMetadata.DeletedDate&&
    s.secretMetadata.VersionIdsToStages?.[launch.secretVersion]?.includes('AWSCURRENT'),'RDS_MANAGED_CURRENT_VERSION');
  for(const kind of ['api','worker']) {
    const o=s[kind];
    check(o?.taskDefinition?.taskRoleArn!==iam.Arn&&
      (iam.Arn===existingRole||o.taskDefinition.executionRoleArn!==iam.Arn),'OWNER_AS_APP_ROLE');
    const expectedRuntime=mode==='inspect'?launch[kind]:{image:r.bridgeImage,source:r.source};
    check(allowedImage(expectedRuntime?.image)&&/^[0-9a-f]{40}$/.test(expectedRuntime?.source),'RUNTIME_IDENTITY_PINS');
    verifyService(o,kind,expectedRuntime,mode!=='inspect');
  }
  const vpc=s.database.DBSubnetGroup?.VpcId, net=launch.network;
  check(/^vpc-[0-9a-f]+$/.test(vpc)&&['DISABLED','ENABLED'].includes(net?.assignPublicIp)&&net.securityGroups?.length===1&&
    /^sg-[0-9a-f]+$/.test(net.securityGroups[0])&&net.subnets?.length>0&&net.subnets.length<=16&&
    new Set(net.subnets).size===net.subnets.length&&net.subnets.every(x=>/^subnet-[0-9a-f]+$/.test(x)),'OWNER_PRIVATE_NETWORK');
  check(s.subnets?.length===net.subnets.length&&same(sorted(s.subnets.map(x=>x.SubnetId)),sorted(net.subnets))&&
    s.subnets.every(x=>x.VpcId===vpc&&x.State==='available')&&s.ownerGroup?.GroupId===net.securityGroups[0]&&
    s.ownerGroup.VpcId===vpc&&acceptableIngress(s.ownerGroup),'OWNER_VPC');
  const dbGroups=s.database.VpcSecurityGroups?.filter(g=>g.Status==='active').map(g=>g.VpcSecurityGroupId)||[];
  check(s.databaseGroups?.some(g=>dbGroups.includes(g.GroupId)&&g.VpcId===vpc&&g.IpPermissions?.some(p=>
    allowsPort(p,5432)&&(p.UserIdGroupPairs?.some(peer=>peer.GroupId===s.ownerGroup.GroupId&&(!peer.UserId||peer.UserId===account))||
      s.subnets.every(sn=>p.IpRanges?.some(range=>subnetWithin(sn.CidrBlock,range.CidrIp)))))),'RDS_INGRESS_FROM_OWNER');
  const egress=s.ownerGroup.IpPermissionsEgress||[];
  check(egress.some(p=>allowsPort(p,443)&&p.IpRanges?.some(x=>x.CidrIp==='0.0.0.0/0'))&&
    egress.some(p=>allowsPort(p,5432)&&(p.UserIdGroupPairs?.some(x=>dbGroups.includes(x.GroupId))||
      p.IpRanges?.some(x=>x.CidrIp==='0.0.0.0/0'))),'OWNER_EGRESS');
  for(const sn of s.subnets) {
    const tables=s.routeTables?.filter(t=>t.VpcId===vpc)||[];
    const table=tables.find(t=>t.Associations?.some(a=>a.SubnetId===sn.SubnetId))??tables.find(t=>t.Associations?.some(a=>a.Main));
    const route=table?.Routes?.find(x=>x.DestinationCidrBlock==='0.0.0.0/0'&&x.State==='active');
    check(net.assignPublicIp==='ENABLED'?/^igw-[0-9a-f]+$/.test(route?.GatewayId):/^nat-[0-9a-f]+$/.test(route?.NatGatewayId),'OWNER_BOOTSTRAP_ROUTE');
  }
}

export function ownerRegistration(input, now=new Date()) {
  verifyObservation(input,now);
  if(input.mode==='apply')verifyRehearsal(input,now);
  return expectedRegistration(input,now);
}

function expectedRegistration(input, now) {
  const {review:r,mode}=input, binding=reconstructionDigest(r), rehearsal=input.rehearsal?.report;
  const values={NODE_ENV:'production',PACKPROOF_RELEASE_SHA:r.source,PACKPROOF_RELEASE_IMAGE:r.candidateImage,
    PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_ORDER_WORKSPACE_ENABLED:'false',
    PACKPROOF_DB_CA_FILE:'/app/backend/certs/rds-us-east-1-bundle.pem',PACKPROOF_HOSTED_MIGRATION_REVIEW_JSON:JSON.stringify(r),
    PACKPROOF_HOSTED_MIGRATION_REVIEW_SHA256:binding};
  if(mode==='apply')values.PACKPROOF_HOSTED_MIGRATION_REHEARSAL_JSON=JSON.stringify(rehearsal);
  validateOwnerReview(r,binding,mode,values,now);
  const family='packproof-connect-owner-'+r.source.slice(0,12)+'-'+mode;
  return {family,networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],cpu:'512',memory:'1024',
    executionRoleArn:r.ownerLaunch.executionRoleArn,runtimePlatform:{cpuArchitecture:'X86_64',operatingSystemFamily:'LINUX'},
    containerDefinitions:[{name:'owner',image:r.candidateImage,essential:true,readonlyRootFilesystem:true,user:'1000:1000',
      workingDirectory:'/app/backend',entryPoint:['node'],command:['/release/connect-hosted-migration.mjs',mode],
      environment:Object.entries(values).map(([name,value])=>({name,value})),
      secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:r.ownerLaunch.ownerSecretArn+':password::'+r.ownerLaunch.secretVersion}],
      logConfiguration:{logDriver:'awslogs',options:{'awslogs-region':region,'awslogs-group':logGroup,'awslogs-stream-prefix':stream,mode:'blocking'}}}]};
}

// Only explicit ECS DescribeTaskDefinition metadata and the documented no-op defaults
// may differ from the reviewed request. Unexpected options, volumes and IAM roles fail.
function verifyRegistration(td, expected) {
  const copy=structuredClone(td);
  const prefix='arn:aws:ecs:'+region+':'+account+':task-definition/'+expected.family+':';
  check(td?.status==='ACTIVE'&&td.taskDefinitionArn?.startsWith(prefix)&&/^[1-9]\d*$/.test(td.taskDefinitionArn.slice(prefix.length)),'REGISTRATION_FAMILY');
  for(const k of ['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'])delete copy[k];
  for(const k of ['volumes','placementConstraints','inferenceAccelerators'])if(same(copy[k]??null,[]))delete copy[k];
  if(copy.enableFaultInjection===false)delete copy.enableFaultInjection;
  for(const c of copy.containerDefinitions??[]) {
    if(c.cpu===0)delete c.cpu;
    for(const k of ['portMappings','mountPoints','volumesFrom','systemControls','environmentFiles','resourceRequirements','dependsOn','ulimits'])if(same(c[k]??null,[]))delete c[k];
    if(same(c.logConfiguration?.secretOptions??null,[]))delete c.logConfiguration.secretOptions;
    if(Array.isArray(c.environment))c.environment.sort((a,b)=>a.name.localeCompare(b.name));
  }
  const normalized=structuredClone(expected);
  normalized.containerDefinitions[0].environment.sort((a,b)=>a.name.localeCompare(b.name));
  check(same(copy,normalized),'REGISTRATION_DRIFT');
  return td.taskDefinitionArn;
}

function verifyRehearsal(input, now) {
  const {review,rehearsal:q}=input;
  const expected=ownerRegistration({...input,mode:'rehearse',rehearsal:undefined},now);
  verifyCompletedTask(q,expected,review.candidateImage);
}

function verifyCompletedTask(q,expected,image) {
  const arn=verifyRegistration(q?.taskDefinition??q?.registered?.taskDefinition??q?.registered,expected), task=q.task, report=q.report;
  check(taskId(task?.taskArn)&&task.taskArn===report.actualTask&&task.clusterArn===cluster&&task.taskDefinitionArn===arn&&
    task.lastStatus==='STOPPED'&&task.containers?.length===1&&task.containers[0].name==='owner'&&
    task.containers[0].imageDigest===image.split('@')[1]&&task.containers[0].exitCode===0&&
    !task.overrides?.taskRoleArn&&!task.overrides?.executionRoleArn&&
    (task.overrides?.containerOverrides??[]).every(c=>Object.keys(c).length===1&&c.name==='owner'),'REHEARSAL_TASK');
}

export function verifyOwnerInspection(inspection,review,now=new Date()) {
  const {review:prior,report}=inspection;
  const completed=Date.parse(report?.completedAt);
  check(report?.schema==='packproof.hosted-collector-owner-receipt/v1'&&report.mode==='inspect'&&
    prior?.source===review.source&&report.source===review.source&&prior.candidateImage===review.candidateImage&&
    report.image===review.candidateImage&&report.targetHost===review.target.host&&prior.ownerRole===review.ownerRole&&
    report.reviewSha256===reconstructionDigest(prior)&&report.rolledBack===false&&
    report.initialLedger===report.finalLedger&&same(report.applied,[])&&report.grantStatementCount===0&&
    completed<=now.getTime()&&completed>=now.getTime()-2*3600000,'INSPECTION_RECEIPT');
  verifyCompletedTask(inspection,expectedRegistration({mode:'inspect',review:prior},new Date(completed)),review.candidateImage);
  return report.initialLedger;
}

export function ownerRunRequest(input, now=new Date()) {
  const expected=ownerRegistration(input,now), td=verifyRegistration(input.registered?.taskDefinition??input.registered,expected);
  const {review:r,mode}=input;
  const retry=input.retryOf;
  if(retry)check(taskId(retry.taskArn)&&retry.clusterArn===cluster&&retry.taskDefinitionArn===td&&
    retry.lastStatus==='STOPPED'&&(retry.stopCode==='TaskFailedToStart'||retry.containers?.some(c=>c.name==='owner'&&Number.isInteger(c.exitCode)&&c.exitCode!==0)),
    'FAILED_ATTEMPT_REQUIRED');
  return {cluster,count:1,taskDefinition:td,launchType:'FARGATE',platformVersion:'1.4.0',
    enableExecuteCommand:false,networkConfiguration:{awsvpcConfiguration:structuredClone(r.ownerLaunch.network)},
    clientToken:hash({review:r,mode,td,retryOf:retry?.taskArn??null}),startedBy:'connect-owner-'+r.source.slice(0,12)+'-'+mode};
}

// The observe phase reads identities and metadata only. No secret value is requested.
function aws(service, operation, args=[]) {
  try {
    return JSON.parse(execFileSync('aws',[service,operation,...args,'--region',region,'--no-cli-pager','--output','json'],
      {encoding:'utf8',timeout:25000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));
  }catch{throw Error('OWNER_TASK_READ_'+operation.replaceAll('-','_').toUpperCase());}
}
function one(list,code) {check(list?.length===1,code);return list[0];}
export async function observeServices({apiOnly=false}={}) {
  check(aws('sts','get-caller-identity').Account===account,'ACCOUNT');
  const names=apiOnly?[TARGET.serviceName]:[TARGET.serviceName,worker];
  const items=aws('ecs','describe-services',['--cluster',cluster,'--services',...names]);
  check(items.services?.length===names.length&&!items.failures?.length,'SERVICES_NOT_FOUND');
  const express=aws('ecs','describe-express-gateway-service',['--service-arn',TARGET.serviceArn]).service;
  const config=one(express?.activeConfigurations,'API_TRAFFIC');
  const revision=one(aws('ecs','describe-service-revisions',['--service-revision-arns',config.serviceRevisionArn]).serviceRevisions,'API_REVISION');
  const list=aws('ecs','list-service-deployments',['--cluster',cluster,'--service',TARGET.serviceName]).serviceDeployments;
  const newest=[...(list??[])].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  check(newest?.serviceDeploymentArn,'API_DEPLOYMENT');
  const native=one(aws('ecs','describe-service-deployments',['--service-deployment-arns',newest.serviceDeploymentArn]).serviceDeployments,'API_DEPLOYMENT');
  check(native.targetServiceRevision?.arn===revision.serviceRevisionArn,'API_REVISION');
  const response=await fetch('https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws/meta',
    {redirect:'error',signal:AbortSignal.timeout(12000)});
  check(response.ok,'API_META');const {commit,image,version}=await response.json();
  const out={};
  for(const name of names) {
    const isApi=name===TARGET.serviceName,found=items.services.find(s=>s.serviceName===name);
    const service=isApi?serviceWithRevision(found,revision):found;
    const taskDefinition=aws('ecs','describe-task-definition',['--task-definition',service.taskDefinition]).taskDefinition;
    const arns=aws('ecs','list-tasks',['--cluster',cluster,'--service-name',name,'--desired-status','RUNNING']).taskArns;
    check(arns?.length>0&&arns.length<=100,'RUNNING_TASK_COUNT');
    const live=aws('ecs','describe-tasks',['--cluster',cluster,'--tasks',...arns]);
    check(!live.failures?.length&&live.tasks?.length===arns.length,'TASKS_NOT_FOUND');
    const observation={service,taskDefinition,tasks:live.tasks};
    if(isApi)Object.assign(observation,{express,revision,nativeDeployment:native,nativeDeploymentStatus:native.status,meta:{commit,image,version}});
    out[isApi?'api':'worker']=observation;
  }
  return out;
}
export async function observeOwner(input) {
  const started=Date.now();
  check(aws('sts','get-caller-identity').Account===account,'ACCOUNT');
  const database=one(aws('rds','describe-db-instances',['--db-instance-identifier','packproof-v2-staging-db']).DBInstances,'DATABASE');
  const secret=validateDatabase(database);
  const snapshot={observedAt:new Date(started).toISOString(),account,region,database};
  if(input.databaseOnly===true)return snapshot;
  const launch=input.review?.ownerLaunch??input,net=launch.network,requested=launch.executionRoleArn;
  check([roleArn,existingRole].includes(requested)&&net?.securityGroups?.length===1&&net.subnets?.length>=1&&net.subnets.length<=16,'OBSERVATION_PARAMETERS');
  check(net.subnets.every(x=>/^subnet-[0-9a-f]+$/.test(x))&&/^sg-[0-9a-f]+$/.test(net.securityGroups[0]),'NETWORK_IDENTIFIERS');
  const dbGroups=database.VpcSecurityGroups.filter(g=>g.Status==='active').map(g=>g.VpcSecurityGroupId);
  const groups=aws('ec2','describe-security-groups',['--group-ids',...new Set([net.securityGroups[0],...dbGroups])]).SecurityGroups;
  const subnets=aws('ec2','describe-subnets',['--subnet-ids',...net.subnets]).Subnets;
  const routeTables=aws('ec2','describe-route-tables',['--filters','Name=vpc-id,Values='+database.DBSubnetGroup.VpcId]).RouteTables;
  const name=requested.split('/').at(-1),ownerRole=aws('iam','get-role',['--role-name',name]).Role;
  const policy=requested===roleArn?{
    ownerAttachedPolicies:aws('iam','list-attached-role-policies',['--role-name',name]).AttachedPolicies,
    ownerInlinePolicyNames:aws('iam','list-role-policies',['--role-name',name]).PolicyNames,
    ownerInlinePolicy:aws('iam','get-role-policy',['--role-name',name,'--policy-name','RunOwnerOnly']).PolicyDocument
  }:{ownerSecretSimulation:aws('iam','simulate-principal-policy',['--policy-source-arn',requested,'--action-names',
    'secretsmanager:GetSecretValue','--resource-arns',secret]).EvaluationResults};
  const {ARN,DeletedDate,VersionIdsToStages}=aws('secretsmanager','describe-secret',['--secret-id',secret]);
  const current=Object.entries(VersionIdsToStages??{}).filter(([,stages])=>stages.includes('AWSCURRENT'));
  check(current.length===1,'CURRENT_SECRET_VERSION');
  const services=await observeServices();
  const workerContainer=one(services.worker.taskDefinition.containerDefinitions.filter(c=>env(c).PACKPROOF_PROCESS_ROLE==='worker'),'WORKER_BINDINGS');
  const ownerLaunch={executionRoleArn:ownerRole.Arn,roleId:ownerRole.RoleId,ownerSecretArn:secret,secretVersion:current[0][0],
    network:net,api:{source:services.api.meta.commit,image:services.api.meta.image},
    worker:{source:env(workerContainer).PACKPROOF_RELEASE_SHA,image:workerContainer.image}};
  return {...snapshot,...services,ownerRole,...policy,ownerLaunch,secretMetadata:{ARN,DeletedDate,VersionIdsToStages},
    subnets,ownerGroup:groups.find(g=>g.GroupId===net.securityGroups[0]),databaseGroups:groups.filter(g=>dbGroups.includes(g.GroupId)),routeTables};
}

async function main() {
  const [phase,from,to]=process.argv.slice(2),input=JSON.parse(await readFile(from,'utf8'));
  check(process.argv.length===5&&['register','run','execution-role','network-group','observe'].includes(phase),'CLI_PHASE');
  const output=phase==='observe'?await observeOwner(input):phase==='network-group'?ownerSecurityGroupTemplate(input.snapshot.database):phase==='execution-role'?ownerExecutionRoleTemplate(input.snapshot.database):{
    service_name:'ecs',operation_name:phase==='register'?'RegisterTaskDefinition':'RunTask',region_name:region,
    params:phase==='register'?ownerRegistration(input):ownerRunRequest(input)};
  await writeFile(to,JSON.stringify(output,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({phase,written:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(/^[A-Z0-9_]+$/.test(e?.message)?e.message:'OWNER_TASK_INPUT_FAILED');process.exitCode=1;
});
