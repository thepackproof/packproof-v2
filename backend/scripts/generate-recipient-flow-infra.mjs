// Separate synthetic recipient workflow. No production database, bucket or service changes.
import fs from 'node:fs';
const root=new URL('../../',import.meta.url),prefix='packproof-m2r-20261022',account='784514617543',region='us-east-1';
const ref=Ref=>({Ref}),att=(name,field='Arn')=>({'Fn::GetAtt':[name,field]}),sub=value=>({'Fn::Sub':value});
const allow=(Sid,Action,Resource,extra={})=>({Sid,Effect:'Allow',Action,Resource,...extra});
const deny=(Sid,Action,Resource,extra={})=>({Sid,Effect:'Deny',Action,Resource,...extra});
const ecsTrust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'ecs-tasks.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':account},ArnLike:{'aws:SourceArn':`arn:aws:ecs:${region}:${account}:*`}}}]};
const t={AWSTemplateFormatVersion:'2010-09-09',Description:'Isolated M2 recipient API, worker and fresh restore acceptance. Synthetic domain workflow only; no production service.',Parameters:{
 CandidateCommit:{Type:'String',AllowedPattern:'[a-f0-9]{40}'},Image:{Type:'String',AllowedPattern:'784514617543.dkr.ecr.us-east-1.amazonaws.com/packproof-m1-20261021-runtime@sha256:[a-f0-9]{64}'},
 ServiceSecurityGroup:{Type:'String',AllowedPattern:'sg-[a-f0-9]+'},WriterFence:{Type:'String',AllowedValues:['OPEN','CLOSED'],Default:'CLOSED'},
 TemporaryBuildAuthority:{Type:'String',AllowedValues:['true','false'],Default:'false'},ConfigurationVersion:{Type:'String',Default:'UNINITIALIZED'},ConfigurationDigest:{Type:'String',Default:'',AllowedPattern:'(|[a-f0-9]{64})'},
},Conditions:{Fenced:{'Fn::Equals':[ref('WriterFence'),'CLOSED']},BuildAuthorityEnabled:{'Fn::Equals':[ref('TemporaryBuildAuthority'),'true']}},Resources:{},Outputs:{}};
const r=t.Resources;
for(const name of ['Upload','Committed','Journal','Recipient']){
 const locked=name!=='Upload';
 r[`${name}Bucket`]={Type:'AWS::S3::Bucket',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{
  PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true},OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},
  BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},VersioningConfiguration:{Status:'Enabled'},
  ...(locked?{ObjectLockEnabled:true,ObjectLockConfiguration:{ObjectLockEnabled:'Enabled',Rule:{DefaultRetention:{Mode:'COMPLIANCE',Days:2}}}}:{}),
  Tags:[{Key:'system',Value:'packproof'},{Key:'purpose',Value:'isolated-m2-synthetic'}],
 }};
 const statements=[{...deny('TransportMustBeTls','s3:*',[att(`${name}Bucket`),sub(`\${${name}Bucket.Arn}/*`)],{Condition:{Bool:{'aws:SecureTransport':'false'}}}),Principal:'*'}];
 if(['Journal','Recipient'].includes(name))statements.push({...deny('ConditionalCreationRequired','s3:PutObject',sub(`\${${name}Bucket.Arn}/*`),{Condition:{Null:{'s3:if-none-match':'true'}}}),Principal:'*'});
 r[`${name}Policy`]={Type:'AWS::S3::BucketPolicy',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Bucket:ref(`${name}Bucket`),PolicyDocument:{Version:'2012-10-17',Statement:statements}}};
 t.Outputs[`${name}Bucket`]={Value:ref(`${name}Bucket`)};
}
for(const name of ['Manifest','Recovery']){
 r[`${name}Key`]={Type:'AWS::KMS::Key',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Description:`${prefix} ${name} signing; synthetic only`,KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',PendingWindowInDays:30,KeyPolicy:{Version:'2012-10-17',Statement:[{Sid:'AccountAdministration',Effect:'Allow',Principal:{AWS:`arn:aws:iam::${account}:root`},Action:'kms:*',Resource:'*'}]},Tags:[{Key:'system',Value:'packproof'},{Key:'purpose',Value:'isolated-m2-synthetic'}]}};
 t.Outputs[`${name}Key`]={Value:att(`${name}Key`)};
}
r.Logs={Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{LogGroupName:`/packproof/${prefix}`,RetentionInDays:30}};
for(const kind of ['Api','Worker','Restore']){
 r[`${kind}DatabaseSecret`]={Type:'AWS::SecretsManager::Secret',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Name:`${prefix}/${kind}Database`,Description:'Synthetic M2 dedicated database login; injected only into its matching task'}};
 const protectedArns=['Committed','Journal','Recipient'].map(x=>sub(`\${${x}Bucket.Arn}/*`));
 const statements=[
  allow('ReadExactProtectedVersions',['s3:GetObjectVersion','s3:GetObjectRetention'],protectedArns),
  ...(kind==='Worker'?[allow('DiscoverOwnPublishedObjects','s3:GetObject',['Journal','Recipient'].map(x=>sub(`\${${x}Bucket.Arn}/*`))),allow('DistinguishAbsentJournalAndRecipient','s3:ListBucket',['Journal','Recipient'].map(x=>att(`${x}Bucket`)))]:[]),
  allow('ReadPinnedConfiguration',['s3:GetObject','s3:GetObjectVersion'],sub('${UploadBucket.Arn}/acceptance/recipient/config/*')),
  ...(kind==='Restore'?[allow('ReadPinnedWorkerHandoff',['s3:GetObject','s3:GetObjectVersion'],sub('${UploadBucket.Arn}/acceptance/recipient/worker/*')),allow('ReadPriorRestoreReport','s3:GetObjectVersion',sub('${UploadBucket.Arn}/acceptance/recipient/restore/*'))]:[]),
  allow('WriteAcceptanceReports','s3:PutObject',sub(`\${UploadBucket.Arn}/acceptance/recipient/${kind.toLowerCase()}/*`)),
  allow('ReadPublicSigningKeys','kms:GetPublicKey',['Manifest','Recovery'].map(x=>att(`${x}Key`))),
  deny('NoProtectionOrKeyAdministration',['s3:DeleteObject','s3:DeleteObjectVersion','s3:BypassGovernanceRetention','s3:PutObjectRetention','s3:PutObjectLegalHold','s3:PutBucketPolicy','s3:PutBucketVersioning','s3:PutBucketObjectLockConfiguration','kms:ScheduleKeyDeletion','kms:DisableKey','kms:PutKeyPolicy','kms:CreateGrant'],'*'),
  deny('NeverWriteOriginals','s3:PutObject',sub('${CommittedBucket.Arn}/*')),
  deny('NoOwnerSecrets','secretsmanager:GetSecretValue','*'),
  deny('NeverSignRootManifests','kms:Sign',att('ManifestKey')),
 ];
 if(kind==='Worker'){
  statements.push(allow('WriteJournalAndRecipient','s3:PutObject',[sub('${JournalBucket.Arn}/recovery/*'),sub('${RecipientBucket.Arn}/recipient-exports/v2/*')]));
  statements.push(allow('SignOnlyWorkerProfiles','kms:Sign',[att('RecoveryKey')],{Condition:{StringEquals:{'kms:SigningAlgorithm':'ECDSA_SHA_256','kms:MessageType':'DIGEST'}}}));
  statements.push({'Fn::If':['Fenced',deny('IndependentWriterFence',['s3:PutObject','kms:Sign'],[sub('${JournalBucket.Arn}/*'),sub('${RecipientBucket.Arn}/*'),att('RecoveryKey')]),ref('AWS::NoValue')]});
 }else statements.push(deny('RestoreCannotSignOrPublish',['kms:Sign','s3:PutObject'],[...['Manifest','Recovery'].map(x=>att(`${x}Key`)),sub('${JournalBucket.Arn}/*'),sub('${RecipientBucket.Arn}/*')]));
 r[`${kind}Role`]={Type:'AWS::IAM::Role',Properties:{RoleName:`${prefix}-${kind.toLowerCase()}`,AssumeRolePolicyDocument:ecsTrust,Policies:[{PolicyName:'BoundedSyntheticWorkload',PolicyDocument:{Version:'2012-10-17',Statement:statements}}]}};
 r[`${kind}ExecutionRole`]={Type:'AWS::IAM::Role',Properties:{RoleName:`${prefix}-${kind.toLowerCase()}-execution`,AssumeRolePolicyDocument:ecsTrust,Policies:[{PolicyName:'OnlyMatchingTaskExecution',PolicyDocument:{Version:'2012-10-17',Statement:[
  allow('EcrAuthentication','ecr:GetAuthorizationToken','*'),allow('ExactRepositoryPull',['ecr:BatchGetImage','ecr:GetDownloadUrlForLayer','ecr:BatchCheckLayerAvailability'],`arn:aws:ecr:${region}:${account}:repository/packproof-m1-20261021-runtime`),
  allow('TaskLogs',['logs:CreateLogStream','logs:PutLogEvents'],sub('arn:aws:logs:us-east-1:784514617543:log-group:${Logs}:*')),allow('OnlyMatchingDatabaseLogin','secretsmanager:GetSecretValue',ref(`${kind}DatabaseSecret`)),
 ]}}]}};
 const env={AWS_REGION:region,PACKPROOF_TEST_PURPOSE:'isolated-m2-synthetic',PACKPROOF_PROCESS_ROLE:kind.toLowerCase(),PACKPROOF_RELEASE_SHA:ref('CandidateCommit'),PACKPROOF_RELEASE_IMAGE:ref('Image'),
  PACKPROOF_DB_HOST:'packproof-m1-20261020-db.c8v2esku2zyt.us-east-1.rds.amazonaws.com',PACKPROOF_DB_NAME:kind==='Restore'?'m2_recipient_restore_20261022':'m2_recipient_20261022',PACKPROOF_DB_USER:kind==='Restore'?'packproof_restore_recipient_20261022':`m2_recipient_${kind.toLowerCase()}_20261022`,PACKPROOF_DB_CA_FILE:'/app/backend/certs/rds-us-east-1-bundle.pem',
  M2_UPLOAD_BUCKET:ref('UploadBucket'),M2_COMMITTED_BUCKET:ref('CommittedBucket'),M2_JOURNAL_BUCKET:ref('JournalBucket'),M2_RECIPIENT_BUCKET:ref('RecipientBucket'),M2_MANIFEST_KEY_ARN:att('ManifestKey'),M2_RECOVERY_KEY_ARN:att('RecoveryKey'),
  M2_CONFIGURATION_VERSION:ref('ConfigurationVersion'),M2_CONFIGURATION_DIGEST:ref('ConfigurationDigest'),M2_MODE:kind==='Worker'?'seed':kind==='Api'?'request':'restore',PACKPROOF_ORGANIZATIONS_ENABLED:'true',PACKPROOF_CLAIM_EXPORTS_ENABLED:'true',
  M2_DATABASE_SECRET_ARN:ref(`${kind}DatabaseSecret`),
 };
 const log={LogDriver:'awslogs',Options:{'awslogs-group':ref('Logs'),'awslogs-region':region,'awslogs-stream-prefix':kind.toLowerCase(),mode:'blocking'}};
 r[`${kind}Task`]={Type:'AWS::ECS::TaskDefinition',Properties:{Family:`${prefix}-${kind.toLowerCase()}`,Cpu:'512',Memory:'2048',NetworkMode:'awsvpc',RequiresCompatibilities:['FARGATE'],RuntimePlatform:{CpuArchitecture:'X86_64',OperatingSystemFamily:'LINUX'},ExecutionRoleArn:att(`${kind}ExecutionRole`),TaskRoleArn:att(`${kind}Role`),Volumes:[{Name:'temporary'}],ContainerDefinitions:[
  {Name:kind.toLowerCase(),Image:ref('Image'),Essential:true,ReadonlyRootFilesystem:true,User:'1000:1000',MountPoints:[{SourceVolume:'temporary',ContainerPath:'/tmp',ReadOnly:false}],Command:['node','scripts/isolated-recipient-acceptance.mjs'],Environment:Object.entries(env).map(([Name,Value])=>({Name,Value})),Secrets:[{Name:'PACKPROOF_DB_PASSWORD',ValueFrom:ref(`${kind}DatabaseSecret`)}],StopTimeout:60,LinuxParameters:{InitProcessEnabled:true},LogConfiguration:log,DependsOn:[{ContainerName:'temporary-volume-init',Condition:'SUCCESS'}]},
  {Name:'temporary-volume-init',Image:ref('Image'),Essential:false,User:'0:0',ReadonlyRootFilesystem:true,MountPoints:[{SourceVolume:'temporary',ContainerPath:'/tmp',ReadOnly:false}],Command:['node','-e',"require('node:fs').chmodSync('/tmp',0o1777)"],LogConfiguration:log},
 ]}};
 for(const suffix of ['Role','ExecutionRole','Task','DatabaseSecret'])t.Outputs[`${kind}${suffix}`]={Value:suffix==='Role'||suffix==='ExecutionRole'?att(`${kind}${suffix}`):ref(`${kind}${suffix}`)};
}
// Optional attachment is removed before the old temporary build role is paused.
// That existing role already owns the isolated database bootstrap boundary.
r.TemporaryBuildPolicy={Type:'AWS::IAM::Policy',Condition:'BuildAuthorityEnabled',Properties:{PolicyName:`${prefix}-temporary-bootstrap`,Roles:['packproof-m1-20261021-runtime-build'],PolicyDocument:{Version:'2012-10-17',Statement:[
 allow('ConfigureOnlyM2Logins','secretsmanager:PutSecretValue',['Api','Worker','Restore'].map(x=>ref(`${x}DatabaseSecret`))),
 allow('ReadOnlyNewKeyMaterial','kms:GetPublicKey',['Manifest','Recovery'].map(x=>att(`${x}Key`))),allow('SignSyntheticCoreAndTrust','kms:Sign',att('ManifestKey')),
 allow('SyntheticFixtureStorage',['s3:GetObject','s3:GetObjectVersion','s3:GetObjectRetention','s3:PutObject'],['Upload','Committed'].map(x=>sub(`\${${x}Bucket.Arn}/*`))),
 allow('DistinguishAbsentSyntheticOriginal','s3:ListBucket',['Upload','Committed'].map(x=>att(`${x}Bucket`))),
 allow('InspectNewStorageProtection',['s3:GetBucketVersioning','s3:GetBucketObjectLockConfiguration'],['Committed','Journal','Recipient'].map(x=>att(`${x}Bucket`))),
 allow('ReadWorkerReports',['s3:GetObject','s3:GetObjectVersion'],sub('${UploadBucket.Arn}/acceptance/recipient/*')),
 allow('RunOnlyM2Families','ecs:RunTask',['api','worker','restore'].map(x=>`arn:aws:ecs:${region}:${account}:task-definition/${prefix}-${x}:*`),{Condition:{ArnEquals:{'ecs:cluster':`arn:aws:ecs:${region}:${account}:cluster/packproof-m1-20261021-runtime`}}}),
 allow('PassOnlyM2TaskRoles','iam:PassRole',['Api','Worker','Restore'].flatMap(x=>[att(`${x}Role`),att(`${x}ExecutionRole`)]),{Condition:{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}}}),
 ]}}};
t.Outputs.ServiceSecurityGroup={Value:ref('ServiceSecurityGroup')};t.Outputs.Logs={Value:ref('Logs')};
fs.writeFileSync(new URL('infra/partner-foundation/recipient-flow-assets.json',root),JSON.stringify(t)+'\n');
console.log(JSON.stringify({template:'recipient-flow-assets.json',resources:Object.keys(r).length,productionResources:0,services:0}));
