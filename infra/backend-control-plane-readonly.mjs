/** Read-only AWS discovery. Whitelist output; never emit raw environment/policy documents. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const region='us-east-1',account='784514617543',cluster='packproof-v2-staging-cluster',serviceName='packproof-v2-staging-api';
const expectedArn=`arn:aws:ecs:${region}:${account}:service/${cluster}/${serviceName}`;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const calls=[];
function aws(service,operation,args=[]){
  const call={service,operation,status:'PENDING'};calls.push(call);
  try{const result=JSON.parse(execFileSync('aws',[service,operation,...args,'--region',region,'--output','json','--no-cli-pager'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));call.status='SUCCESS';return result;}
  catch{call.status='FAILED';return null;}
}
const pick=(v,names)=>Object.fromEntries(names.filter(n=>v?.[n]!==undefined).map(n=>[n,v[n]]));
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
  const task=aws('ecs','describe-task-definition',['--task-definition',service.taskDefinition])?.taskDefinition;
  result.taskDefinition=task?{...pick(task,['taskDefinitionArn','family','revision','taskRoleArn','executionRoleArn','networkMode','cpu','memory','runtimePlatform','ephemeralStorage','requiresCompatibilities']),configurationSha256:hash(task),containers:(task.containerDefinitions??[]).map(v=>({...primarySummary(v),...pick(v,['name','user','readonlyRootFilesystem','healthCheck','portMappings','memory','memoryReservation','cpu'])}))}:null;
  const taskArns=aws('ecs','list-tasks',['--cluster',cluster,'--service-name',serviceName,'--desired-status','RUNNING'])?.taskArns??[];
  result.runningTasks=taskArns.length?(aws('ecs','describe-tasks',['--cluster',cluster,'--tasks',...taskArns])?.tasks??[]).map(v=>({...pick(v,['taskArn','taskDefinitionArn','lastStatus','healthStatus','platformVersion']),containers:(v.containers??[]).map(c=>pick(c,['name','image','imageDigest','lastStatus','healthStatus','networkInterfaces']))})):[];
  const deploys=aws('ecs','list-service-deployments',['--cluster',cluster,'--service',serviceName])?.serviceDeployments??[];
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
  const targetArns=[...new Set((service.loadBalancers??[]).map(x=>x.targetGroupArn).filter(Boolean))];
  const groups=targetArns.length?aws('elbv2','describe-target-groups',['--target-group-arns',...targetArns])?.TargetGroups??[]:[];
  result.targetGroups=groups.map(v=>pick(v,['TargetGroupArn','Protocol','Port','TargetType','HealthCheckProtocol','HealthCheckPath','HealthCheckPort','VpcId','LoadBalancerArns']));
  const albArns=[...new Set(groups.flatMap(v=>v.LoadBalancerArns??[]))];
  const albs=albArns.length?aws('elbv2','describe-load-balancers',['--load-balancer-arns',...albArns])?.LoadBalancers??[]:[];
  result.loadBalancers=albs.map(v=>({...pick(v,['LoadBalancerArn','DNSName','Scheme','VpcId','Type','SecurityGroups','AvailabilityZones']),attributes:aws('elbv2','describe-load-balancer-attributes',['--load-balancer-arn',v.LoadBalancerArn])?.Attributes?.filter(x=>['routing.http.xff_header_processing.mode','routing.http.xff_client_port.enabled','routing.http.preserve_host_header.enabled','routing.http.drop_invalid_header_fields.enabled','deletion_protection.enabled'].includes(x.Key))}));
  const vpcNet=service.networkConfiguration?.awsvpcConfiguration??{},sgs=[...new Set([...(vpcNet.securityGroups??[]),...albs.flatMap(x=>x.SecurityGroups??[])])];
  result.securityGroups=sgs.length?(aws('ec2','describe-security-groups',['--group-ids',...sgs])?.SecurityGroups??[]).map(v=>pick(v,['GroupId','GroupName','VpcId','IpPermissions'])):[];
  const subnets=[...new Set([...(vpcNet.subnets??[]),...albs.flatMap(x=>(x.AvailabilityZones??[]).map(z=>z.SubnetId))])];
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
