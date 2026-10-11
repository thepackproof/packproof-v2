/** Read-only AWS discovery. Whitelist output; never emit raw environment/policy documents. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const region='us-east-1',account='784514617543',cluster='packproof-v2-staging-cluster',serviceName='packproof-v2-staging-api';
const expectedArn=`arn:aws:ecs:${region}:${account}:service/${cluster}/${serviceName}`;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const calls=[];
function failure(error){
  // Never persist stderr, command arguments, messages or unknown error values.
  const localCodes={ERR_INVALID_ARG_TYPE:'INVALID_ARGUMENTS',ERR_INVALID_ARG_VALUE:'INVALID_ARGUMENTS',ENOENT:'CLI_UNAVAILABLE',ETIMEDOUT:'TIMEOUT',ENOBUFS:'OUTPUT_LIMIT'};
  if(Object.hasOwn(localCodes,error?.code))return {errorCategory:'LOCAL',errorCode:localCodes[error.code]};
  if(error instanceof SyntaxError)return {errorCategory:'RESPONSE',errorCode:'INVALID_JSON'};
  const stderr=String(error?.stderr??'');
  const codes={
    AccessDenied:'ACCESS_DENIED',AccessDeniedException:'ACCESS_DENIED',UnauthorizedOperation:'ACCESS_DENIED',
    ExpiredToken:'AUTHENTICATION',ExpiredTokenException:'AUTHENTICATION',InvalidClientTokenId:'AUTHENTICATION',UnrecognizedClientException:'AUTHENTICATION',
    InvalidParameterException:'INVALID_REQUEST',InvalidParameterValue:'INVALID_REQUEST',ValidationError:'INVALID_REQUEST',ValidationException:'INVALID_REQUEST',
    ClusterNotFoundException:'NOT_FOUND',ServiceNotFoundException:'NOT_FOUND',ResourceNotFoundException:'NOT_FOUND',LoadBalancerNotFound:'NOT_FOUND',TargetGroupNotFound:'NOT_FOUND',NoSuchEntity:'NOT_FOUND',NoSuchBucket:'NOT_FOUND',
    Throttling:'THROTTLED',ThrottlingException:'THROTTLED',TooManyRequestsException:'THROTTLED',
    UnsupportedFeatureException:'UNSUPPORTED',ClientException:'SERVICE_ERROR',ServerException:'SERVICE_ERROR',ServiceUnavailableException:'SERVICE_ERROR'
  };
  const code=stderr.match(/An error occurred \(([A-Za-z0-9_.]{1,80})\) when calling/)?.[1];
  if(Object.hasOwn(codes,code))return {errorCategory:codes[code],errorCode:code};
  if(stderr.includes('Unable to locate credentials'))return {errorCategory:'AUTHENTICATION',errorCode:'CREDENTIALS_UNAVAILABLE'};
  if(stderr.includes('Unknown options:')||stderr.includes('Invalid choice:')||stderr.includes('expected one argument'))return {errorCategory:'LOCAL',errorCode:'CLI_ARGUMENT_ERROR'};
  return {errorCategory:'UNKNOWN',errorCode:'UNCLASSIFIED_FAILURE'};
}
function aws(service,operation,args=[]){
  const call={service,operation,status:'PENDING'};calls.push(call);
  if(args.some(v=>typeof v!=='string'||!v.length)){Object.assign(call,{status:'FAILED',errorCategory:'LOCAL',errorCode:'INVALID_ARGUMENTS'});return null;}
  try{const result=JSON.parse(execFileSync('aws',[service,operation,...args,'--region',region,'--output','json','--no-cli-pager'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));call.status='SUCCESS';if(result.failures?.length)Object.assign(call,{status:'PARTIAL',errorCategory:'RESOURCE',errorCode:'RESOURCE_READ_FAILURE',failureCount:result.failures.length});return result;}
  catch(error){Object.assign(call,{status:'FAILED',...failure(error)});return null;}
}
const pick=(v,names)=>Object.fromEntries(names.filter(n=>v?.[n]!==undefined).map(n=>[n,v[n]]));
const unique=values=>[...new Set(values)];
const taskPrefix=`arn:aws:ecs:${region}:${account}:task-definition/`;
const taskArn=v=>typeof v==='string'&&v===v.trim()&&v.startsWith(taskPrefix)&&/^[A-Za-z0-9_-]+:[0-9]+$/.test(v.slice(taskPrefix.length));
const albPrefix=`arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/`;
const albDimension=v=>typeof v==='string'&&v===v.trim()&&v.length<=64&&/^app\/[A-Za-z0-9-]{1,32}\/[a-f0-9]{16}$/.test(v);
const albArn=v=>typeof v==='string'&&v.startsWith(albPrefix)&&albDimension(v.slice(albPrefix.length));
const revisionPrefix=`arn:aws:ecs:${region}:${account}:service-revision/${cluster}/${serviceName}/`;
const revisionArn=v=>typeof v==='string'&&v===v.trim()&&v.startsWith(revisionPrefix)&&/^[A-Za-z0-9_-]+$/.test(v.slice(revisionPrefix.length));
const eniId=v=>typeof v==='string'&&v===v.trim()&&/^eni-[a-f0-9]{8,17}$/.test(v);
const bindingNames=items=>(items??[]).map(v=>v.name).filter(v=>typeof v==='string').sort();
function primarySummary(v){
  if(!v)return null;
  const entries=v.environment??[],names=[...bindingNames(entries),...bindingNames(v.secrets)],map=Object.fromEntries(entries.map(x=>[x.name,x.value]));
  const proxy=map.PACKPROOF_TRUSTED_PROXIES;
  return {...pick(v,['image','containerPort','awsLogsConfiguration']),environmentNames:bindingNames(entries),secretNames:bindingNames(v.secrets),
    duplicateBindingCount:names.length-new Set(names).size,configurationSha256:hash(v),
    trustedProxies:proxy===undefined?{configured:false}:/^[0-9a-fA-F.:/,\s]+$/.test(proxy)?{configured:true,value:proxy}:{configured:true,invalidOrRedacted:true},
    migrateOnStart:map.PACKPROOF_MIGRATE_ON_START==='false'?'false':map.PACKPROOF_MIGRATE_ON_START==='true'?'true':'unset_or_unrecognized',
    releaseSha:/^[a-f0-9]{40}$/.test(map.PACKPROOF_RELEASE_SHA??'')?map.PACKPROOF_RELEASE_SHA:null,
    environmentAndSecretBindingsSha256:hash({environment:entries,secrets:v.secrets??[]})};
}
async function main(){
  if(process.argv.length!==3)throw Error('Expected one output JSON path');
  const identity=aws('sts','get-caller-identity');
  if(identity?.Account!==account)throw Error('Expected AWS account authentication unavailable');
  const result={observedAt:new Date().toISOString(),sourceSha:/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')?process.env.GITHUB_SHA:null,readOnly:true,account,region,principalArn:identity.Arn,calls};
  const service=aws('ecs','describe-services',['--cluster',cluster,'--services',serviceName])?.services?.[0];
  if(service?.serviceArn!==expectedArn)throw Error('Expected existing service unavailable');
  result.service={...pick(service,['serviceArn','taskDefinition','status','desiredCount','runningCount','pendingCount','capacityProviderStrategy','launchType','platformVersion','networkConfiguration','deploymentConfiguration','healthCheckGracePeriodSeconds','loadBalancers']),
    deployments:(service.deployments??[]).map(v=>pick(v,['id','status','taskDefinition','desiredCount','runningCount','pendingCount','rolloutState','rolloutStateReason'])),configurationSha256:hash(service)};
  const express=aws('ecs','describe-express-gateway-service',['--service-arn',expectedArn])?.service;
  result.express=express?{...pick(express,['serviceArn','status','infrastructureRoleArn']),configurationSha256:hash(express),activeConfigurations:(express.activeConfigurations??[]).map(v=>({...pick(v,['serviceRevisionArn','executionRoleArn','taskRoleArn','cpu','memory','networkConfiguration','scalingTarget','healthCheckPath','ingressPaths']),primaryContainer:primarySummary(v.primaryContainer),configurationSha256:hash(v)}))}:null;
  const revisionArns=unique((express?.activeConfigurations??[]).map(v=>v.serviceRevisionArn).filter(revisionArn));
  const revisions=revisionArns.length?(aws('ecs','describe-service-revisions',['--service-revision-arns',...revisionArns])?.serviceRevisions??[]).filter(v=>revisionArns.includes(v.serviceRevisionArn)&&v.serviceArn===expectedArn):[];
  result.serviceRevisions=revisions.map(v=>({...pick(v,['serviceRevisionArn','serviceArn','taskDefinition','capacityProviderStrategy','launchType','platformVersion','networkConfiguration','loadBalancers']),resolvedLoadBalancers:(v.resolvedConfiguration?.loadBalancers??[]).map(x=>pick(x,['targetGroupArn','productionListenerRule'])),managedIngress:(v.ecsManagedResources?.ingressPaths??[]).map(x=>({...pick(x,['accessType','endpoint']),loadBalancer:pick(x.loadBalancer,['arn','status'])})),configurationSha256:hash(v)}));
  const taskArns=aws('ecs','list-tasks',['--cluster',cluster,'--service-name',serviceName,'--desired-status','RUNNING'])?.taskArns??[];
  const runningTasks=taskArns.length?aws('ecs','describe-tasks',['--cluster',cluster,'--tasks',...taskArns])?.tasks??[]:[];
  result.runningTasks=runningTasks.map(v=>({...pick(v,['taskArn','taskDefinitionArn','lastStatus','healthStatus','platformVersion']),containers:(v.containers??[]).map(c=>pick(c,['name','image','imageDigest','lastStatus','healthStatus','networkInterfaces']))}));
  // Express services can omit the ordinary ECS service's top-level fields.
  // Prefer its PRIMARY deployment, then a single unambiguous running revision.
  const primaryTasks=unique((service.deployments??[]).filter(v=>v.status==='PRIMARY').map(v=>v.taskDefinition).filter(taskArn));
  const revisionTasks=unique(revisions.map(v=>v.taskDefinition).filter(taskArn));
  const runningDefinitions=unique(result.runningTasks.map(v=>v.taskDefinitionArn).filter(taskArn));
  const taskReference=taskArn(service.taskDefinition)?{source:'service.taskDefinition',arn:service.taskDefinition}:primaryTasks.length===1?{source:'service.PRIMARY.taskDefinition',arn:primaryTasks[0]}:revisionTasks.length===1?{source:'serviceRevisions.taskDefinition',arn:revisionTasks[0]}:runningDefinitions.length===1?{source:'runningTasks.taskDefinitionArn',arn:runningDefinitions[0]}:null;
  result.discoverySources={taskDefinition:taskReference?.source??'UNAVAILABLE'};
  if(!taskReference)calls.push({service:'ecs',operation:'describe-task-definition',status:'SKIPPED',errorCategory:'DISCOVERY',errorCode:'MISSING_UNAMBIGUOUS_REFERENCE'});
  const task=taskReference?aws('ecs','describe-task-definition',['--task-definition',taskReference.arn])?.taskDefinition:null;
  result.taskDefinition=task?{...pick(task,['taskDefinitionArn','family','revision','taskRoleArn','executionRoleArn','networkMode','cpu','memory','runtimePlatform','ephemeralStorage','requiresCompatibilities']),configurationSha256:hash(task),containers:(task.containerDefinitions??[]).map(v=>({...primarySummary(v),...pick(v,['name','user','readonlyRootFilesystem','healthCheck','portMappings','memory','memoryReservation','cpu'])}))}:null;
  // --service accepts a name or ARN; use the already verified full identity.
  const deploys=aws('ecs','list-service-deployments',['--cluster',cluster,'--service',expectedArn])?.serviceDeployments??[];
  result.nativeDeployments=deploys.map(v=>pick(v,['serviceDeploymentArn','status','createdAt','startedAt','finishedAt','targetServiceRevisionArn']));
  if(deploys.length)result.latestNativeDeployment=aws('ecs','describe-service-deployments',['--service-deployment-arns',deploys[0].serviceDeploymentArn])?.serviceDeployments?.map(v=>pick(v,['serviceDeploymentArn','status','statusReason','targetServiceRevision','sourceServiceRevisions','deploymentConfiguration','deploymentCircuitBreaker','alarms','rollback']));
  const project=aws('codebuild','batch-get-projects',['--names',serviceName])?.projects?.[0];
  result.codeBuild=project?{...pick(project,['name','arn','serviceRole','timeoutInMinutes','queuedTimeoutInMinutes','logsConfig','vpcConfig']),source:pick(project.source,['type','location','buildspec']),artifacts:pick(project.artifacts,['type','location','encryptionDisabled']),environment:{...pick(project.environment,['type','computeType','image','privilegedMode']),variables:(project.environment?.environmentVariables??[]).map(v=>pick(v,['name','type']))},configurationSha256:hash(project)}:null;
  // Do not emit an inline buildspec: it can contain environment or command secrets.
  if(result.codeBuild?.source?.buildspec){result.codeBuild.source.buildspecSha256=hash(result.codeBuild.source.buildspec);delete result.codeBuild.source.buildspec;}
  const repository=aws('ecr','describe-repositories',['--repository-names',serviceName])?.repositories?.[0];
  result.repository=repository?pick(repository,['repositoryArn','repositoryUri','imageTagMutability','imageScanningConfiguration','encryptionConfiguration']):null;
  const lifecycle=aws('ecr','get-lifecycle-policy',['--repository-name',serviceName]);
  result.ecrLifecycle=lifecycle?{policy:JSON.parse(lifecycle.lifecyclePolicyText),lastEvaluatedAt:lifecycle.lastEvaluatedAt}:null;
  result.sourceBucketVersioning=aws('s3api','get-bucket-versioning',['--bucket',`packproof-v2-staging-build-${account}`]);
  const database=aws('rds','describe-db-instances',['--db-instance-identifier','packproof-v2-staging-db'])?.DBInstances?.[0];
  result.database=database?pick(database,['DBInstanceIdentifier','DBInstanceStatus','Engine','EngineVersion','BackupRetentionPeriod','LatestRestorableTime','EarliestRestorableTime','MultiAZ','StorageEncrypted','DeletionProtection']):null;
  const targetArns=unique([...(service.loadBalancers??[]),...revisions.flatMap(v=>[...(v.loadBalancers??[]),...(v.resolvedConfiguration?.loadBalancers??[])])].map(x=>x.targetGroupArn).filter(Boolean));
  const groups=targetArns.length?aws('elbv2','describe-target-groups',['--target-group-arns',...targetArns])?.TargetGroups??[]:[];
  // Read only the ALB explicitly named by this service's primary environment.
  // Never enumerate account-wide load balancers or print environment values.
  const dimensions=(express?.activeConfigurations??[]).flatMap(v=>{
    const bindings=(v.primaryContainer?.environment??[]).filter(x=>x.name==='PACKPROOF_ADMIN_ALB_DIMENSION');
    return bindings.length===1&&albDimension(bindings[0].value)?[bindings[0].value]:[];
  });
  const envAlbs=unique(dimensions.map(v=>albPrefix+v));
  const managedAlbs=unique(revisions.flatMap(v=>(v.ecsManagedResources?.ingressPaths??[]).map(x=>x.loadBalancer?.arn)).filter(albArn));
  const albArns=unique([...groups.flatMap(v=>v.LoadBalancerArns??[]).filter(albArn),...envAlbs,...managedAlbs]);
  result.discoverySources.loadBalancers={serviceTargetGroupCount:targetArns.length,validPrimaryEnvironmentReferences:envAlbs.length,managedRevisionReferences:managedAlbs.length};
  const albs=albArns.length?aws('elbv2','describe-load-balancers',['--load-balancer-arns',...albArns])?.LoadBalancers??[]:[];
  for(const arn of unique([...envAlbs,...managedAlbs]).filter(arn=>albs.some(v=>v.LoadBalancerArn===arn))){
    groups.push(...(aws('elbv2','describe-target-groups',['--load-balancer-arn',arn])?.TargetGroups??[]));
  }
  result.targetGroups=[...new Map(groups.map(v=>[v.TargetGroupArn,v])).values()].map(v=>pick(v,['TargetGroupArn','Protocol','Port','TargetType','HealthCheckProtocol','HealthCheckPath','HealthCheckPort','VpcId','LoadBalancerArns']));
  result.loadBalancers=albs.map(v=>({...pick(v,['LoadBalancerArn','DNSName','Scheme','VpcId','Type','SecurityGroups','AvailabilityZones']),attributes:aws('elbv2','describe-load-balancer-attributes',['--load-balancer-arn',v.LoadBalancerArn])?.Attributes?.filter(x=>['routing.http.xff_header_processing.mode','routing.http.xff_client_port.enabled','routing.http.preserve_host_header.enabled','routing.http.drop_invalid_header_fields.enabled','deletion_protection.enabled'].includes(x.Key))}));
  const networks=[service.networkConfiguration?.awsvpcConfiguration,...(express?.activeConfigurations??[]).map(v=>v.networkConfiguration),...revisions.map(v=>v.networkConfiguration?.awsvpcConfiguration)].filter(Boolean);
  const assignments=[{source:'service',reference:expectedArn,value:service.networkConfiguration?.awsvpcConfiguration?.assignPublicIp},...revisions.map(v=>({source:'serviceRevision',reference:v.serviceRevisionArn,value:v.networkConfiguration?.awsvpcConfiguration?.assignPublicIp}))].filter(v=>['ENABLED','DISABLED'].includes(v.value)).map(v=>({source:v.source,reference:v.reference,enabled:v.value==='ENABLED'}));
  // Assignment configuration and an observed ENI association are distinct evidence.
  // If configuration is missing, inspect only ENIs attached to these running tasks.
  const eniArns=unique(runningTasks.flatMap(v=>(v.attachments??[]).filter(x=>x.type==='ElasticNetworkInterface').flatMap(x=>(x.details??[]).filter(d=>d.name==='networkInterfaceId').map(d=>d.value))).filter(eniId));
  const needsInterfaces=assignments.length===0||revisions.some(v=>!['ENABLED','DISABLED'].includes(v.networkConfiguration?.awsvpcConfiguration?.assignPublicIp));
  const interfaces=needsInterfaces&&eniArns.length?(aws('ec2','describe-network-interfaces',['--network-interface-ids',...eniArns])?.NetworkInterfaces??[]).filter(v=>eniArns.includes(v.NetworkInterfaceId)):[];
  result.networkEvidence={assignPublicIp:assignments,runningTaskInterfaces:interfaces.map(v=>({...pick(v,['NetworkInterfaceId','SubnetId','VpcId','Status']),securityGroups:(v.Groups??[]).map(x=>x.GroupId),hasPublicIp:typeof v.Association?.PublicIp==='string'&&v.Association.PublicIp.length>0})),taskInterfaceReferences:eniArns.length,interfaceLookupNeeded:needsInterfaces};
  result.discoverySources.network={serviceAwsvpc:!!service.networkConfiguration?.awsvpcConfiguration,expressConfigurationCount:(express?.activeConfigurations??[]).filter(v=>v.networkConfiguration).length,serviceRevisionCount:revisions.filter(v=>v.networkConfiguration?.awsvpcConfiguration).length};
  const sgs=unique([...networks.flatMap(v=>v.securityGroups??[]),...interfaces.flatMap(v=>(v.Groups??[]).map(x=>x.GroupId)),...albs.flatMap(x=>x.SecurityGroups??[])]);
  result.securityGroups=sgs.length?(aws('ec2','describe-security-groups',['--group-ids',...sgs])?.SecurityGroups??[]).map(v=>pick(v,['GroupId','GroupName','VpcId','IpPermissions'])):[];
  const subnets=unique([...networks.flatMap(v=>v.subnets??[]),...interfaces.map(v=>v.SubnetId),...albs.flatMap(x=>(x.AvailabilityZones??[]).map(z=>z.SubnetId))]);
  result.subnets=subnets.length?(aws('ec2','describe-subnets',['--subnet-ids',...subnets])?.Subnets??[]).map(v=>pick(v,['SubnetId','VpcId','CidrBlock','Ipv6CidrBlockAssociationSet'])):[];
  const role=aws('iam','get-role',['--role-name','PackProofGitHubDeploy'])?.Role;
  result.deployRole=role?{...pick(role,['Arn','RoleName','MaxSessionDuration','PermissionsBoundary']),trustDocumentSha256:hash(role.AssumeRolePolicyDocument),trustStatements:(role.AssumeRolePolicyDocument.Statement??[]).map(s=>({Effect:s.Effect,Action:s.Action,Federated:s.Principal?.Federated,Condition:Object.fromEntries(Object.entries(s.Condition??{}).map(([op,values])=>[op,Object.fromEntries(Object.entries(values).filter(([name])=>name.startsWith('token.actions.githubusercontent.com:')))]))}))}:null;
  const policies=aws('iam','list-role-policies',['--role-name','PackProofGitHubDeploy'])?.PolicyNames??[];
  result.deployRoleInlinePolicies=policies.map(name=>{const p=aws('iam','get-role-policy',['--role-name','PackProofGitHubDeploy','--policy-name',name]);return {name,...(p?{sha256:hash(p.PolicyDocument),statements:p.PolicyDocument.Statement.map(s=>pick(s,['Effect','Action','NotAction','Resource','NotResource','Condition']))}:{unavailable:true})};});
  result.deployRoleAttachedPolicies=aws('iam','list-attached-role-policies',['--role-name','PackProofGitHubDeploy'])?.AttachedPolicies??null;
  // IAM policy documents are authorization metadata, not credentials. Secret
  // contents, container env values, credentials and inline build commands absent.
  result.completedAt=new Date().toISOString();
  result.allReadCallsSucceeded=calls.every(v=>v.status==='SUCCESS');
  await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({readOnly:true,account,calls:calls.length,allReadCallsSucceeded:result.allReadCallsSucceeded}));
}
main().catch(()=>{console.error('READ_ONLY_DISCOVERY_FAILED: inspect authentication and whitelisted receipt; raw AWS output withheld');process.exitCode=1;});
