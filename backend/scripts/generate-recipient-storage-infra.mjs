// Independent synthetic buckets and one-shot roles; no production or DB resources.
import fs from 'node:fs';
const root=new URL('../../',import.meta.url),ref=Ref=>({Ref}),att=(name,field='Arn')=>({'Fn::GetAtt':[name,field]}),sub=value=>({'Fn::Sub':value});
const account='784514617543',region='us-east-1',repository=`arn:aws:ecr:${region}:${account}:repository/packproof-m1-20261021-runtime`;
const allow=(Sid,Action,Resource,extra={})=>({Sid,Effect:'Allow',Action,Resource,...extra});
const deny=(Sid,Action,Resource,extra={})=>({Sid,Effect:'Deny',Action,Resource,...extra});
const source=fs.readFileSync(new URL('isolated-recipient-storage-probe.mjs',import.meta.url),'utf8');
const t={AWSTemplateFormatVersion:'2010-09-09',Description:'Synthetic recipient storage role acceptance only. No database, services, production or merchant actions.',Parameters:{
 ApplicationCommit:{Type:'String',AllowedPattern:'[a-f0-9]{40}'},HarnessCommit:{Type:'String',AllowedPattern:'[a-f0-9]{40}'},
 Image:{Type:'String',AllowedPattern:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-m1-20261021-runtime@sha256:[a-f0-9]{64}'},
 RetainUntil:{Type:'String',AllowedPattern:'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z',Description:'Explicit synthetic preservation boundary within 24 hours; bucket minimum is two days.'},
 WriterFence:{Type:'String',AllowedValues:['OPEN','CLOSED'],Default:'CLOSED'},
},Conditions:{Fenced:{'Fn::Equals':[ref('WriterFence'),'CLOSED']}},Resources:{},Outputs:{}};
const r=t.Resources;
for(const name of ['Recipient','Reports','Canary']){
 const locked=name!=='Reports';
 r[`${name}Bucket`]={Type:'AWS::S3::Bucket',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{
  PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true},OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},
  BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},VersioningConfiguration:{Status:'Enabled'},
  ...(locked?{ObjectLockEnabled:true,ObjectLockConfiguration:{ObjectLockEnabled:'Enabled',Rule:{DefaultRetention:{Mode:'COMPLIANCE',Days:2}}}}:{}),
  Tags:[{Key:'purpose',Value:'isolated-recipient-storage'}],
 }};
 const statements=[{...deny('TlsRequired','s3:*',[att(`${name}Bucket`),sub(`\${${name}Bucket.Arn}/*`)],{Condition:{Bool:{'aws:SecureTransport':'false'}}}),Principal:'*'}];
 if(name==='Recipient')statements.push({...deny('ConditionalCreationRequired','s3:PutObject',sub('${RecipientBucket.Arn}/*'),{Condition:{Null:{'s3:if-none-match':'true'}}}),Principal:'*'});
 r[`${name}BucketPolicy`]={Type:'AWS::S3::BucketPolicy',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Bucket:ref(`${name}Bucket`),PolicyDocument:{Version:'2012-10-17',Statement:statements}}};
 t.Outputs[`${name}Bucket`]={Description:`Isolated ${name.toLowerCase()} bucket`,Value:ref(`${name}Bucket`)};
}
r.Logs={Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{LogGroupName:sub('/packproof/${AWS::StackName}'),RetentionInDays:30}};
const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ecs-tasks.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account},ArnLike:{'aws:SourceArn':`arn:aws:ecs:${region}:${account}:*`}}}]};
for(const kind of ['worker','api','restore']){
 const name=kind[0].toUpperCase()+kind.slice(1);
 const policies=[allow('ReadExactRecipientVersions',['s3:GetObjectVersion','s3:GetObjectRetention'],sub('${RecipientBucket.Arn}/recipient-exports/v2/*')),
  allow('ReadOperatorConfiguration',['s3:GetObject','s3:GetObjectVersion'],sub('${ReportsBucket.Arn}/configuration/*')),
  allow('WriteOwnReports','s3:PutObject',sub(`\${ReportsBucket.Arn}/acceptance/${kind}/*`)),
  deny('NoProtectionAdministration',['s3:DeleteObject','s3:DeleteObjectVersion','s3:PutObjectRetention','s3:PutObjectLegalHold','s3:BypassGovernanceRetention','s3:PutBucketPolicy','s3:PutBucketVersioning','s3:PutBucketObjectLockConfiguration'],'*'),
  deny('NoSecretsOrSigning',['secretsmanager:GetSecretValue','kms:Sign'],'*'),
  deny('DenyCanaryBucket','s3:*',[att('CanaryBucket'),sub('${CanaryBucket.Arn}/*')]),
 ];
 if(kind==='worker'){
  policies.push(allow('DiscoverOnlyOwnRecipientVersions','s3:GetObject',sub('${RecipientBucket.Arn}/recipient-exports/v2/*')),
   allow('DistinguishMissingRecipient','s3:ListBucket',att('RecipientBucket')),
   allow('CreateConditionalRecipientObjects','s3:PutObject',sub('${RecipientBucket.Arn}/recipient-exports/v2/*')),
   {'Fn::If':['Fenced',deny('IndependentWriterFence','s3:PutObject',sub('${RecipientBucket.Arn}/*')),ref('AWS::NoValue')]});
 }else policies.push(allow('ReadPinnedWorkerReport','s3:GetObjectVersion',sub('${ReportsBucket.Arn}/acceptance/worker/*')),
  deny('NeverPublishProtectedObjects','s3:PutObject',sub('${RecipientBucket.Arn}/*')));
 r[`${name}Role`]={Type:'AWS::IAM::Role',Properties:{RoleName:sub(`\${AWS::StackName}-${kind}`),AssumeRolePolicyDocument:trust,Policies:[{PolicyName:'SyntheticRecipientProbe',PolicyDocument:{Version:'2012-10-17',Statement:policies}}]}};
 r[`${name}ExecutionRole`]={Type:'AWS::IAM::Role',Properties:{RoleName:sub(`\${AWS::StackName}-${kind}-exec`),AssumeRolePolicyDocument:trust,Policies:[{PolicyName:'ImageAndLogsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
  allow('EcrAuthorization','ecr:GetAuthorizationToken','*'),allow('PinnedRepositoryPull',['ecr:BatchGetImage','ecr:GetDownloadUrlForLayer','ecr:BatchCheckLayerAvailability'],repository),
  allow('TaskLogs',['logs:CreateLogStream','logs:PutLogEvents'],sub('arn:aws:logs:us-east-1:784514617543:log-group:${Logs}:*')),
 ]}}]}};
 const env={PURPOSE:'isolated-recipient-storage',ACCOUNT:account,REGION:region,ROLE:kind,STACK:ref('AWS::StackName'),SOURCE:ref('ApplicationCommit'),HARNESS:ref('HarnessCommit'),IMAGE:ref('Image'),BUCKET:ref('RecipientBucket'),REPORTS:ref('ReportsBucket'),CANARY:ref('CanaryBucket'),RETAIN_UNTIL:ref('RetainUntil')};
 r[`${name}Task`]={Type:'AWS::ECS::TaskDefinition',Properties:{Family:sub(`\${AWS::StackName}-${kind}`),Cpu:'256',Memory:'512',NetworkMode:'awsvpc',RequiresCompatibilities:['FARGATE'],RuntimePlatform:{CpuArchitecture:'X86_64',OperatingSystemFamily:'LINUX'},TaskRoleArn:att(`${name}Role`),ExecutionRoleArn:att(`${name}ExecutionRole`),ContainerDefinitions:[{
  Name:kind,Image:ref('Image'),Essential:true,User:'1000:1000',ReadonlyRootFilesystem:true,WorkingDirectory:'/app/backend',Command:['node','--input-type=module','--eval',source],Environment:Object.entries(env).map(([key,Value])=>({Name:'M2_'+key,Value})),
  LinuxParameters:{InitProcessEnabled:true},StopTimeout:30,LogConfiguration:{LogDriver:'awslogs',Options:{'awslogs-group':ref('Logs'),'awslogs-region':region,'awslogs-stream-prefix':kind,mode:'blocking'}},
 }]}};
 for(const suffix of ['Role','ExecutionRole','Task'])t.Outputs[`${name}${suffix}`]={Description:`Isolated ${kind} ${suffix}`,Value:suffix==='Task'?ref(`${name}${suffix}`):att(`${name}${suffix}`)};
}
t.Outputs.Logs={Description:'Retained synthetic task logs',Value:ref('Logs')};
// The three tasks embed the same reviewed probe. Compact serialization keeps the
// self-contained template within CloudFormation's 51,200-byte inline limit.
const output=JSON.stringify(t)+'\n';
if(Buffer.byteLength(output)>51200)throw Error('Template exceeds inline CloudFormation limit');
fs.writeFileSync(new URL('infra/partner-foundation/recipient-storage-assets.json',root),output);
console.log(JSON.stringify({resources:Object.keys(r).length,bytes:Buffer.byteLength(output),services:0,productionResources:0}));
