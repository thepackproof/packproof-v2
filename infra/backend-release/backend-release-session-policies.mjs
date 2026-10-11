/** Phase-scoped restrictions on the EXISTING role, never IAM policy mutations. */
import {TARGET} from './backend-deployment-plan.mjs';
const statement=(Action,Resource,Condition)=>({Effect:'Allow',Action,Resource,...(Condition?{Condition}:{})});
const describe=['sts:GetCallerIdentity','ecs:DescribeServices','ecs:DescribeExpressGatewayService','ecs:DescribeTaskDefinition','ecs:ListTasks','ecs:DescribeTasks','ecs:ListServiceDeployments','ecs:DescribeServiceDeployments','ecs:DescribeServiceRevisions'];
const topology=['elasticloadbalancing:DescribeTargetGroups','elasticloadbalancing:DescribeLoadBalancers','elasticloadbalancing:DescribeLoadBalancerAttributes','ec2:DescribeSecurityGroups','ec2:DescribeSubnets'];
export function sessionPolicy(phase,{sourceSha,taskRoleArn,executionRoleArn,infrastructureRoleArn,apiTaskFamily,logGroup}){
 if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('INVALID_SOURCE');
 const region=TARGET.region,account=TARGET.account,repository=`arn:aws:ecr:${region}:${account}:repository/${TARGET.serviceName}`;
 const statements=[];
 if(phase==='build'){
  statements.push(statement([...describe,...topology,'codebuild:BatchGetProjects','codebuild:BatchGetBuilds','s3:GetBucketVersioning','rds:DescribeDBInstances'],'*'));
  statements.push(statement(['s3:PutObject','s3:GetObject','s3:GetObjectVersion'],`arn:aws:s3:::packproof-v2-staging-build-${account}/security-release/${sourceSha}/*`));
  statements.push(statement(['codebuild:StartBuild'],`arn:aws:codebuild:${region}:${account}:project/${TARGET.serviceName}`));
  statements.push(statement(['ecr:DescribeImages','ecr:BatchGetImage','ecr:GetLifecyclePolicy'],repository));
 }else if(phase==='preflight'){
  if(![taskRoleArn,executionRoleArn].every(v=>typeof v==='string'&&v.startsWith(`arn:aws:iam::${account}:role/`))||typeof logGroup!=='string'||!/^\/[A-Za-z0-9/_.-]+$/.test(logGroup))throw Error('REVIEWED_RUNTIME_METADATA_REQUIRED');
  statements.push(statement(describe,'*'));
  statements.push(statement(['ecs:RegisterTaskDefinition'],`arn:aws:ecs:${region}:${account}:task-definition/packproof-security-verifier-${sourceSha.slice(0,12)}-*`));
  statements.push(statement(['ecs:RunTask','ecs:DeregisterTaskDefinition'],`arn:aws:ecs:${region}:${account}:task-definition/packproof-security-verifier-${sourceSha.slice(0,12)}-*`));
  statements.push(statement(['ecs:StopTask'],`arn:aws:ecs:${region}:${account}:task/${TARGET.cluster}/*`,{StringEquals:{'ecs:ResourceTag/packproof-release':sourceSha}}));
  statements.push(statement(['ecs:TagResource'],`arn:aws:ecs:${region}:${account}:task/${TARGET.cluster}/*`,{StringEquals:{'ecs:CreateAction':'RunTask','aws:RequestTag/packproof-release':sourceSha}}));
  statements.push(statement(['iam:PassRole'],[taskRoleArn,executionRoleArn],{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}}));
  statements.push(statement(['logs:GetLogEvents'],`arn:aws:logs:${region}:${account}:log-group:${logGroup}:log-stream:*`));
 }else if(phase==='deploy'){
  if(![taskRoleArn,executionRoleArn,infrastructureRoleArn].every(v=>typeof v==='string'&&v.startsWith(`arn:aws:iam::${account}:role/`))||!/^packproof-[A-Za-z0-9_-]+$/.test(apiTaskFamily??''))throw Error('REVIEWED_DEPLOY_ROLE_METADATA_REQUIRED');
  statements.push(statement([...describe,...topology],'*'));
  statements.push(statement(['ecs:UpdateExpressGatewayService'],TARGET.serviceArn));
  // Express update has these documented dependent permissions; they do not
  // modify the roles and are restricted to the discovered existing identities.
  statements.push(statement(['ecs:RegisterTaskDefinition'],`arn:aws:ecs:${region}:${account}:task-definition/${apiTaskFamily}:*`));
  statements.push(statement(['iam:PassRole'],[taskRoleArn,executionRoleArn],{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}}));
  statements.push(statement(['iam:PassRole'],infrastructureRoleArn,{StringEquals:{'iam:PassedToService':'ecs.amazonaws.com'}}));
  statements.push(statement(['ecr:BatchGetImage'],repository));
 }else throw Error('UNKNOWN_PHASE');
 const policy=JSON.stringify({Version:'2012-10-17',Statement:statements});
 if(Buffer.byteLength(policy)>2048)throw Error('SESSION_POLICY_TOO_LARGE');
 return policy;
}
