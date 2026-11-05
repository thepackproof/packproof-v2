// Offline constructor for the isolated rehearsal only. No AWS calls, production
// owner references, runtime credential generation or service updates.
import {readFile} from 'node:fs/promises';
const account='784514617543',region='us-east-1',name='packproof-records-release-20261105';
const repository=`${account}.dkr.ecr.${region}.amazonaws.com/packproof-v2-staging-api`;
const secretPrefix=`arn:aws:secretsmanager:${region}:${account}:secret:`;
const fail=code=>{throw Error(code);};
export async function rehearsalTemplate({sourceSha,candidateImage,bridgeImage,compatibilityEvidenceSha256,clone,cloneKmsArn,runtimeSecretArn,runtimeKmsArn}){
 const image=value=>typeof value==='string'&&value.startsWith(repository+'@sha256:')&&/^[a-f0-9]{64}$/.test(value.split('@sha256:')[1]??'');
 if(!/^[a-f0-9]{40}$/.test(sourceSha??'')||![candidateImage,bridgeImage].every(image)||candidateImage===bridgeImage||!/^[a-f0-9]{64}$/.test(compatibilityEvidenceSha256??''))fail('RECORDS_REHEARSAL_IMAGE_BINDING_REQUIRED');
 const host=`${name}.c8v2esku2zyt.${region}.rds.amazonaws.com`,secret=clone?.MasterUserSecret?.SecretArn;
 if(clone?.DBInstanceIdentifier!==name||clone.DBInstanceStatus!=='available'||clone.PubliclyAccessible!==false||clone.StorageEncrypted!==true||clone.Endpoint?.Address!==host||clone.MasterUserSecret?.SecretStatus!=='active'||!secret?.startsWith(secretPrefix+'rds!db-')||secret===secretPrefix+'rds!db-8f5824eb-60e0-4f3a-ac2c-630dbb0f734a-RjNM96'||clone.VpcSecurityGroups?.length!==1||clone.VpcSecurityGroups[0].VpcSecurityGroupId!=='sg-02b6a3ac5378c28f5')fail('RECORDS_PRIVATE_RESTORED_DATABASE_REQUIRED');
 if(runtimeSecretArn!==secretPrefix+'packproof/staging/database/runtime-v1-8xneOC'||![cloneKmsArn,runtimeKmsArn].every(value=>new RegExp(`^arn:aws:kms:${region}:${account}:key/[a-f0-9-]{36}$`).test(value??'')))fail('RECORDS_REHEARSAL_SECRET_REFERENCE_REQUIRED');
 const getatt=resource=>({'Fn::GetAtt':[resource,'Arn']});
 const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ecs-tasks.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account},ArnLike:{'aws:SourceArn':`arn:aws:ecs:${region}:${account}:*`}}}]};
 const environment=image=>Object.entries({NODE_ENV:'production',AWS_REGION:region,PACKPROOF_ENVIRONMENT:'production',PACKPROOF_MIGRATE_ON_START:'false',DEV_AUTH:'false',PACKPROOF_ORGANIZATIONS_ENABLED:'false',PACKPROOF_CLAIM_EXPORTS_ENABLED:'false',PACKPROOF_RELEASE_SHA:sourceSha,PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_VERSION:'records-rehearsal-20261105',PACKPROOF_DB_HOST:host,PACKPROOF_DB_NAME:'packproof_v2',PACKPROOF_DB_PORT:'5432',PACKPROOF_DB_SSLMODE:'verify-full',PACKPROOF_DB_CA_FILE:'/app/certs/rds-us-east-1-bundle.pem',PACKPROOF_DB_SECRET_ARN:'',PACKPROOF_COMPATIBILITY_IMAGE_DIGEST:bridgeImage.split('@')[1],PACKPROOF_COMPATIBILITY_EVIDENCE_SHA256:compatibilityEvidenceSha256}).map(([Name,Value])=>({Name,Value}));
 const task=(family,image,secrets,command,extra=[])=>({Type:'AWS::ECS::TaskDefinition',Properties:{Family:family,Cpu:'512',Memory:'1024',NetworkMode:'awsvpc',RequiresCompatibilities:['FARGATE'],RuntimePlatform:{CpuArchitecture:'X86_64',OperatingSystemFamily:'LINUX'},TaskRoleArn:getatt('TaskRole'),ExecutionRoleArn:getatt('ExecutionRole'),ContainerDefinitions:[{Name:'rehearsal',Image:image,Essential:true,ReadonlyRootFilesystem:true,User:'1000:1000',WorkingDirectory:'/app/backend',Command:command,Environment:[...environment(image),...extra],Secrets:[{Name:'PACKPROOF_DB_USER',ValueFrom:secrets+':username::'},{Name:'PACKPROOF_DB_PASSWORD',ValueFrom:secrets+':password::'}],LogConfiguration:{LogDriver:'awslogs',Options:{'awslogs-group':{Ref:'Logs'},'awslogs-region':region,'awslogs-stream-prefix':'rehearsal',mode:'blocking'}}}]}});
 const bridgeScript=await readFile(new URL('./records-bridge-preflight.mjs',import.meta.url),'utf8');
 const bridgeCommand=['node','--input-type=module','-e',bridgeScript,'records-bridge-preflight',sourceSha,bridgeImage.split('@')[1],'baseline'];
 const resources={
  Logs:{Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{LogGroupName:'/packproof/records-release-20261105',RetentionInDays:3}},
  TaskRole:{Type:'AWS::IAM::Role',Properties:{RoleName:name+'-task',AssumeRolePolicyDocument:trust,Policies:[{PolicyName:'no-aws-api-authority',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Deny',Action:'*',Resource:'*'}]}}]}},
  ExecutionRole:{Type:'AWS::IAM::Role',Properties:{RoleName:name+'-execution',AssumeRolePolicyDocument:trust,Policies:[{PolicyName:'exact-rehearsal-injection-pull-and-logs',PolicyDocument:{Version:'2012-10-17',Statement:[
   {Effect:'Allow',Action:'ecr:GetAuthorizationToken',Resource:'*'},
   {Effect:'Allow',Action:['ecr:BatchCheckLayerAvailability','ecr:GetDownloadUrlForLayer','ecr:BatchGetImage'],Resource:`arn:aws:ecr:${region}:${account}:repository/packproof-v2-staging-api`},
   {Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:getatt('Logs')},
   {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:[secret,runtimeSecretArn]},
   {Effect:'Allow',Action:'kms:Decrypt',Resource:[...new Set([cloneKmsArn,runtimeKmsArn])],Condition:{StringEquals:{'kms:ViaService':`secretsmanager.${region}.amazonaws.com`,'kms:EncryptionContext:SecretARN':[secret,runtimeSecretArn]}}},
  ]}}]}},
  OwnerTask:task(name+'-owner',candidateImage,secret,['node','scripts/records-migrate-cli.mjs','--rehearse'],[{Name:'PACKPROOF_OPERATOR_PURPOSE',Value:'records-restored-migration-rehearsal'}]),
  BridgeTask:task(name+'-bridge',bridgeImage,runtimeSecretArn,bridgeCommand),
 };
 return {AWSTemplateFormatVersion:'2010-09-09',Description:'Isolated restored-database records rehearsal; no production service, production owner credential, new runtime credential or feature activation.',Resources:resources,Outputs:{OwnerTask:{Value:{Ref:'OwnerTask'}},BridgeTask:{Value:{Ref:'BridgeTask'}},LogGroup:{Value:{Ref:'Logs'}}}};
}
