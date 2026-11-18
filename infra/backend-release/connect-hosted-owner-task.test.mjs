import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerRegistration,ownerRunRequest,ownerExecutionRoleTemplate,ownerSecurityGroupTemplate} from './connect-hosted-owner-task.mjs';
import {collectorInventory,hostedCollectorTarget as target,reconstructionDigest} from './reconstruction-v11-release-review.mjs';
import {backfillMigrationInventorySha256} from './reconstruction-v8-release-review.mjs';

const now=new Date('2026-11-18T15:00:00Z'), account='784514617543', region='us-east-1',cluster=target.clusterArn;
const repository=target.repository, source='a'.repeat(40), image=repository+'@sha256:'+'1'.repeat(64), bridge=repository+'@sha256:'+'2'.repeat(64);
const secret='arn:aws:secretsmanager:'+region+':'+account+':secret:rds!db-11111111-1111-1111-1111-111111111111-QWER12';
const role='arn:aws:iam::'+account+':role/packproof-connect-hosted-owner-execution';
const tdArn=family=>'arn:aws:ecs:'+region+':'+account+':task-definition/'+family+':17';
const taskArn=c=>cluster.replace(':cluster/',':task/')+'/'+c.repeat(32);
const asRegistered=def=>({...structuredClone(def),taskDefinitionArn:tdArn(def.family),status:'ACTIVE',revision:17,volumes:[],placementConstraints:[]});
function service(kind) {
  const isApi=kind==='api', name=isApi?'packproof-v2-staging-api':'packproof-records-worker',arn=cluster.replace(':cluster/',':service/')+'/'+name;
  const taskDefinitionArn=tdArn(name);
  const environment=Object.entries({PACKPROOF_PROCESS_ROLE:kind,PACKPROOF_ENVIRONMENT:'production',PACKPROOF_DB_HOST:target.host,PACKPROOF_DB_NAME:target.database,
    PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_RELEASE_IMAGE:bridge,PACKPROOF_RELEASE_SHA:source}).map(([name,value])=>({name,value}));
  const c={name:kind,image:bridge,environment};
  return {service:{serviceArn:arn,clusterArn:cluster,status:'ACTIVE',desiredCount:1,pendingCount:0,runningCount:1,taskDefinition:taskDefinitionArn,
    deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:taskDefinitionArn}]},
    taskDefinition:{taskDefinitionArn,status:'ACTIVE',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],containerDefinitions:[c],
      executionRoleArn:'arn:aws:iam::'+account+':role/packproof-v2-staging-execution',taskRoleArn:'arn:aws:iam::'+account+':role/runtime'},
    tasks:[{taskArn:taskArn(isApi?'5':'6'),clusterArn:cluster,taskDefinitionArn,lastStatus:'RUNNING',desiredStatus:'RUNNING',group:'service:'+name,
      containers:[{name:kind,imageDigest:bridge.split('@')[1],lastStatus:'RUNNING'}]}],
    ...(isApi?{nativeDeploymentStatus:'SUCCESSFUL',express:{serviceArn:arn,activeConfigurations:[{primaryContainer:c}]},meta:{commit:source,image:bridge}}:{})};
}
function input(mode) {
  const database={DBInstanceIdentifier:'packproof-v2-staging-db',DBInstanceStatus:'available',Engine:'postgres',EngineVersion:'16.15',Endpoint:{Address:target.host,Port:5432},
    DBName:target.database,PubliclyAccessible:false,StorageEncrypted:true,MasterUsername:'packproof',
    MasterUserSecret:{SecretArn:secret,SecretStatus:'active'},DBSubnetGroup:{VpcId:'vpc-4444'},VpcSecurityGroups:[{Status:'active',VpcSecurityGroupId:'sg-22'}]};
  const iam=ownerExecutionRoleTemplate(database).Resources.OwnerExecution.Properties;
  const ownerLaunch={executionRoleArn:role,roleId:'AROA'+'X'.repeat(17),ownerSecretArn:secret,secretVersion:'a'.repeat(32),
    network:{subnets:['subnet-11'],securityGroups:['sg-11'],assignPublicIp:'ENABLED'},worker:{source,image:bridge},api:{source,image:bridge}};
  const review={schema:'packproof.hosted-collector-migration/v1',source,candidateImage:image,bridgeImage:bridge,
    clusterArn:cluster,target:{host:target.host,database:target.database},inventorySha256:collectorInventory,expectedLedger:backfillMigrationInventorySha256,
    apiRole:'packproof_records_api_v1',workerRole:'packproof_records_worker_v1',ownerRole:'packproof',expiresAt:new Date(+now+3600000).toISOString(),ownerLaunch};
  return {mode,review,snapshot:{observedAt:now.toISOString(),account,region,database,api:service('api'),worker:service('worker'),
    subnets:[{SubnetId:'subnet-11',State:'available',VpcId:'vpc-4444',CidrBlock:'10.20.19.0/24'}],databaseGroups:[{GroupId:'sg-22',VpcId:'vpc-4444',
      IpPermissions:[{IpProtocol:'tcp',FromPort:5432,ToPort:5432,IpRanges:[{CidrIp:'10.20.0.0/16'}]}]}],
    routeTables:[{VpcId:'vpc-4444',Associations:[{Main:true}],Routes:[{State:'active',DestinationCidrBlock:'0.0.0.0/0',GatewayId:'igw-123'}]}],
    ownerGroup:{GroupId:'sg-11',VpcId:'vpc-4444',IpPermissions:[],IpPermissionsEgress:[
      {IpProtocol:'tcp',FromPort:443,ToPort:443,IpRanges:[{CidrIp:'0.0.0.0/0'}]},
      {IpProtocol:'tcp',FromPort:5432,ToPort:5432,UserIdGroupPairs:[{GroupId:'sg-22'}]}]},
    ownerRole:{Arn:role,RoleId:ownerLaunch.roleId,AssumeRolePolicyDocument:iam.AssumeRolePolicyDocument},
    ownerInlinePolicyNames:['RunOwnerOnly'],ownerInlinePolicy:iam.Policies[0].PolicyDocument,ownerAttachedPolicies:[],
    secretMetadata:{ARN:secret,VersionIdsToStages:{[ownerLaunch.secretVersion]:['AWSCURRENT']}}}};
}
test('dedicated owner registration has one pinned command, credential and no ingress or task role',()=>{
 const i=input('rehearse'),def=ownerRegistration(i,now),c=def.containerDefinitions[0];
 assert.equal(def.taskRoleArn,undefined);assert.equal(def.executionRoleArn,role);
 assert.deepEqual(c.entryPoint,['node']);assert.deepEqual(c.command,['/release/connect-hosted-migration.mjs','rehearse']);
 assert.deepEqual(c.secrets,[{name:'PACKPROOF_DB_PASSWORD',valueFrom:secret+':password::'+'a'.repeat(32)}]);
 assert.equal(c.privileged,undefined);assert.equal(c.portMappings,undefined);
 const registered=asRegistered(def);registered.containerDefinitions[0].cpu=0;
 const run=ownerRunRequest({...i,registered},now);
 assert.equal(run.taskDefinition,registered.taskDefinitionArn);assert.equal(run.overrides,undefined);assert.equal(run.enableExecuteCommand,false);
 assert.equal(run.networkConfiguration.awsvpcConfiguration.assignPublicIp,'ENABLED');
 assert.equal(run.clientToken,ownerRunRequest({...i,registered},now).clientToken);
 assert.equal(run.clientToken.length,64);
 registered.containerDefinitions[0].entryPoint=['sh'];assert.throws(()=>ownerRunRequest({...i,registered},now),/REGISTRATION_DRIFT/);
 const net=ownerSecurityGroupTemplate(i.snapshot.database).Resources.OwnerNetwork.Properties;
 assert.deepEqual(net.SecurityGroupIngress,[]);assert.equal(net.SecurityGroupEgress.length,2);
});
test('write registration rejects divergent live tasks, incomplete convergence, wrong network, credentials or role authority',()=>{
 for(const [change,reason] of [
  [i=>{i.snapshot.worker.tasks[0].containers[0].imageDigest='sha256:'+'3'.repeat(64)},'LIVE_SERVICE_TASKS'],
  [i=>{i.snapshot.api.tasks[0].taskDefinitionArn=tdArn('other')},'LIVE_SERVICE_TASKS'],
  [i=>{i.snapshot.worker.service.deployments[0].rolloutState='IN_PROGRESS'},'WORKER_ROLLOUT'],
  [i=>{i.snapshot.api.meta.commit='7'.repeat(40)},'API_TRAFFIC_OR_IDENTITY'],
  [i=>{i.snapshot.ownerGroup.IpPermissions.push({IpProtocol:'-1'})},'OWNER_VPC'],
  [i=>{i.snapshot.databaseGroups[0].IpPermissions[0].IpRanges=[{CidrIp:'192.0.2.0/24'}]},'RDS_INGRESS_FROM_OWNER'],
  [i=>{i.review.ownerLaunch.network.assignPublicIp='DISABLED'},'BOOTSTRAP_ROUTE'],
  [i=>{i.snapshot.ownerRole.RoleId='AROA'+'Y'.repeat(17)},'ROLE_IDENTITY'],
  [i=>{i.snapshot.ownerInlinePolicy.Statement.push({Effect:'Allow',Action:'*',Resource:'*'})},'DEDICATED_EXECUTION_AUTHORITY'],
  [i=>{i.snapshot.api.taskDefinition.taskRoleArn=role},'OWNER_AS_APP_ROLE'],
  [i=>{i.snapshot.secretMetadata.VersionIdsToStages['a'.repeat(32)]=['AWSPREVIOUS']},'CURRENT_VERSION'],
  [i=>{i.snapshot.observedAt=new Date(+now-301000).toISOString()},'FRESH_TARGET'],
 ]) {const i=input('rehearse');change(i);assert.throws(()=>ownerRegistration(i,now),new RegExp(reason));}
});
test('optional existing execution-only role must have effective exact owner-secret admission and cannot be application task role',()=>{
 const i=input('inspect'),existing=i.snapshot.api.taskDefinition.executionRoleArn;
 i.review.ownerLaunch.executionRoleArn=existing;i.snapshot.ownerRole.Arn=existing;
 i.snapshot.ownerSecretSimulation=[{EvalActionName:'secretsmanager:GetSecretValue',EvalResourceName:secret,EvalDecision:'allowed'}];
 assert.equal(ownerRegistration(i,now).executionRoleArn,existing);
 i.snapshot.ownerSecretSimulation[0].EvalDecision='implicitDeny';assert.throws(()=>ownerRegistration(i,now),/EXISTING_OWNER_SECRET_ACCESS/);
});
test('apply binds source, ledger, actual rehearsal definition, task and zero exit status',()=>{
 const i=input('rehearse'),definition=asRegistered(ownerRegistration(i,now));
 i.mode='apply';i.rehearsal={taskDefinition:definition,report:{schema:'packproof.hosted-collector-owner-receipt/v1',mode:'rehearse',source,
   reviewSha256:reconstructionDigest(i.review),image: image,actualTask:taskArn('7'),initialLedger:backfillMigrationInventorySha256,finalLedger:collectorInventory,
   rolledBack:true,targetHost:target.host,completedAt:now.toISOString()},
   task:{taskArn:taskArn('7'),clusterArn:cluster,taskDefinitionArn:definition.taskDefinitionArn,lastStatus:'STOPPED',containers:[
     {name:'owner',imageDigest:image.split('@')[1],exitCode:0}]}};
 assert.deepEqual(ownerRegistration(i,now).containerDefinitions[0].command,['/release/connect-hosted-migration.mjs','apply']);
 i.rehearsal.task.containers[0].exitCode=2;assert.throws(()=>ownerRegistration(i,now),/REHEARSAL_TASK/);
});
test('the existing outbound route runs with the exact ALB-only ingress rule, and explicit retries require a failed task',()=>{
 const i=input('rehearse'), s=i.snapshot, net=i.review.ownerLaunch.network;
 const vpc='vpc-0bbe45c201fdf625d', group='sg-0fbfe8871eef85488';
 s.database.DBSubnetGroup.VpcId=s.databaseGroups[0].VpcId=s.subnets[0].VpcId=s.ownerGroup.VpcId=s.routeTables[0].VpcId=vpc;
 net.securityGroups=[group];s.ownerGroup.GroupId=group;
 s.ownerGroup.IpPermissions=[{IpProtocol:'tcp',FromPort:3000,ToPort:3000,UserIdGroupPairs:[{GroupId:'sg-0803f8500e439f39b',UserId:account}]}];
 const def=ownerRegistration(i,now);i.registered=asRegistered(def);
 const first=ownerRunRequest(i,now), failed={taskArn:taskArn('9'),clusterArn:cluster,lastStatus:'STOPPED',taskDefinitionArn:first.taskDefinition,
   containers:[{name:'owner',exitCode:1}]};
 assert.notEqual(first.clientToken,ownerRunRequest({...i,retryOf:failed},now).clientToken);
 assert.throws(()=>ownerRunRequest({...i,retryOf:{...failed,lastStatus:'RUNNING'}},now),/FAILED_ATTEMPT_REQUIRED/);
 s.ownerGroup.IpPermissions[0].IpRanges=[{CidrIp:'0.0.0.0/0'}];assert.throws(()=>ownerRegistration(i,now),/OWNER_VPC/);
});

import {createOwnerReview,createPairReview} from './connect-hosted-review.mjs';
function reviewInput() {
  const {snapshot,review}=input('inspect');
  snapshot.ownerLaunch=review.ownerLaunch;
  const predecessor=repository+'@sha256:'+'3'.repeat(64);
  const built=(value,tag)=>({imageDetail:{registryId:account,repositoryName:'packproof-v2-staging-api',
    imageTags:[tag+source],imageDigest:value.split('@')[1]},policyEvent:{event:'shipment_release_build_policy',bundleSha256:'b'.repeat(64)}});
  return {snapshot,expiresAt:review.expiresAt,release:{packet:{schema:'packproof.connect-rollout/v1',source,version:'0.6.0',
    approvedPredecessorImage:predecessor,migrationInventorySha256:collectorInventory,files:[{path:'backend.zip',sha256:'c'.repeat(64)}]},
    ci:{name:'CI',headSha:source,conclusion:'success'},bridge:built(bridge,'collector-compat-'),candidate:built(image,'connect-runtime-')}};
}
test('owner review derives its write ledger only from the corresponding stopped inspector and exact read-only receipt',()=>{
  const i=reviewInput(),review=createOwnerReview(i,now);
  assert.equal(review.expectedLedger,undefined);
  const td=asRegistered(ownerRegistration({mode:'inspect',review,snapshot:i.snapshot},now));
  i.inspection={review,registered:td,task:{taskArn:taskArn('9'),clusterArn:cluster,taskDefinitionArn:td.taskDefinitionArn,lastStatus:'STOPPED',
    containers:[{name:'owner',imageDigest:image.split('@')[1],exitCode:0}]},report:{schema:'packproof.hosted-collector-owner-receipt/v1',
      mode:'inspect',source,reviewSha256:reconstructionDigest(review),image,actualTask:taskArn('9'),targetHost:target.host,
      initialLedger:backfillMigrationInventorySha256,finalLedger:backfillMigrationInventorySha256,applied:[],grantStatementCount:0,
      rolledBack:false,completedAt:now.toISOString()}};
  assert.equal(createOwnerReview(i,now).expectedLedger,backfillMigrationInventorySha256);
  i.inspection.task.containers[0].exitCode=1;
  assert.throws(()=>createOwnerReview(i,now),/TASK/);
});
test('pair reviews retain active shipment approval and bind the matching release images, source, lock and archive',()=>{
  const i=reviewInput();
  i.snapshot.topology={test:true};
  i.snapshot.probe={clusterArn:cluster,networkConfiguration:{awsvpcConfiguration:i.snapshot.ownerLaunch.network}};
  for(const kind of ['api','worker']) {
    const c=i.snapshot[kind].taskDefinition.containerDefinitions[0];
    c.environment.push({name:'PACKPROOF_RELEASE_VERSION',value:'prior'},
      {name:'PACKPROOF_SHIPMENT_INTERPRETATION_ENABLED',value:'true'},
      {name:'PACKPROOF_SHIPMENT_WORKER_INTERPRETATION',value:'packproof.shipment-interpretation/v1'});
    c.logConfiguration={logDriver:'awslogs',options:{'awslogs-group':'/ecs/test','awslogs-region':region,'awslogs-stream-prefix':'ecs'}};
  }
  i.profile='candidate';
  const candidate=createPairReview(i,now);
  assert.equal(candidate.preflightReview.preserveShipmentSettings,true);
  assert.equal(candidate.preflightReview.orderWorkspaceEnabled,false);
  assert.equal(candidate.expectedWorker.image,bridge);
  assert.equal(candidate.image,image);
  assert.equal(candidate.sourceArchiveSha256,'c'.repeat(64));
  i.profile='bridge';
  assert.throws(()=>createPairReview(i,now),/OBSERVED_PREDECESSOR/);
  const predecessor=i.release.packet.approvedPredecessorImage;
  for(const kind of ['api','worker']) {
    const o=i.snapshot[kind],c=o.taskDefinition.containerDefinitions[0];
    c.image=predecessor;
    c.environment.find(e=>e.name==='PACKPROOF_RELEASE_IMAGE').value=predecessor;
    o.tasks[0].containers[0].imageDigest=predecessor.split('@')[1];
  }
  i.snapshot.api.meta.image=predecessor;
  const compatibility=createPairReview(i,now);
  assert.equal(compatibility.schema,'packproof.connect-runtime-review/v9');
  assert.equal(compatibility.image,bridge);
  i.release.ci.headSha='0'.repeat(40);
  assert.throws(()=>createPairReview(i,now),/SOURCE_CI/);
});
test('staged publication consumes both content-addressed and reused source tags only for their exact verified registry manifests',()=>{
  const i=reviewInput(),results=[];
  for(const [kind,profile] of [['bridge','collector-hosted-bridge'],['candidate','reconstruction-v11']]){
    const evidence=i.release[kind],imageId='sha256:'+(kind==='bridge'?'4':'5').repeat(64),[base]=evidence.imageDetail.imageTags;
    const contentTag=base+'-'+imageId.slice(7);
    const tag=kind==='candidate'?contentTag:base;
    const imageManifest=JSON.stringify({schemaVersion:2,config:{digest:imageId}});
    const digest='sha256:'+reconstructionDigest(imageManifest);
    evidence.manifestResponse={images:[{registryId:account,repositoryName:evidence.imageDetail.repositoryName,
      imageId:{imageTag:tag,imageDigest:digest},imageManifest}],failures:[]};
    delete evidence.imageDetail;
    results.push({profile,imageId,contentTag,published:{tag,digest,image:repository+'@'+digest}});
  }
  i.release.publication={schema:'packproof.connect-registry-publication/v1',mode:'publish',source,images:results};
  const review=createOwnerReview(i,now);
  assert.equal(review.candidateImage,results[1].published.image);
  assert.equal(review.bridgeImage,results[0].published.image);
  for(const mutate of [x=>x.release.publication.mode='inspect',x=>x.release.publication.source='0'.repeat(40),
    x=>x.release.publication.images[0].contentTag=x.release.publication.images[1].contentTag,
    x=>x.release.publication.images[1].published.digest=x.release.publication.images[0].published.digest,
    x=>x.release.candidate.manifestResponse.images[0].imageManifest+=' ',
    x=>x.release.candidate.manifestResponse=x.release.bridge.manifestResponse]){
    const changed=structuredClone(i);mutate(changed);assert.throws(()=>createOwnerReview(changed,now));
  }
});
