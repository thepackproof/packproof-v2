/** Pure request constructors. No AWS calls. Discover and review inputs before use. */
import { createHash } from 'node:crypto';
import { TARGET, hash } from './backend-deployment-plan.mjs';
const check=(condition,code)=>{if(!condition)throw Error(code);};
const sha=/^[a-f0-9]{40}$/,digest=/^[a-f0-9]{64}$/;
export function buildRequest({sourceSha,zipSha256,sourceVersion,buildspec}){
  check(sha.test(sourceSha)&&digest.test(zipSha256)&&typeof buildspec==='string'&&buildspec.length>0,'INVALID_BUILD_PINS');
  check(sourceVersion===undefined||typeof sourceVersion==='string'&&sourceVersion.length>0&&sourceVersion!=='null','INVALID_S3_VERSION');
  return{projectName:TARGET.serviceName,sourceTypeOverride:'S3',sourceLocationOverride:`packproof-v2-staging-build-${TARGET.account}/security-release/${sourceSha}/${zipSha256}/backend.zip`,
    ...(sourceVersion?{sourceVersion}:{}),buildspecOverride:buildspec,environmentVariablesOverride:[
      {name:'REVIEWED_SOURCE_SHA',value:sourceSha,type:'PLAINTEXT'},
      {name:'IMAGE_TAG',value:`security-${sourceSha}`,type:'PLAINTEXT'}]};
}
export function verifierTaskDefinition(task,{sourceSha,image,version,script,inventorySha256,runId}){
  check(sha.test(sourceSha)&&digest.test(inventorySha256)&&/^[0-9]{1,20}$/.test(runId),'INVALID_VERIFIER_PINS');
  check(image.startsWith(`${TARGET.repository}@sha256:`)&&digest.test(image.split('@sha256:')[1]),'IMMUTABLE_IMAGE_REQUIRED');
  check(task.networkMode==='awsvpc'&&task.requiresCompatibilities?.includes('FARGATE')&&task.containerDefinitions?.length===1,'UNREVIEWED_TASK_SHAPE');
  check(!task.volumes?.length&&!task.proxyConfiguration&&!task.inferenceAccelerators?.length,'UNREVIEWED_TASK_SIDE_EFFECTS');
  const allowed=['family','taskRoleArn','executionRoleArn','networkMode','containerDefinitions','volumes','placementConstraints','requiresCompatibilities','cpu','memory','pidMode','ipcMode','ephemeralStorage','runtimePlatform','enableFaultInjection'];
  const responseOnly=['taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'];
  check(Object.keys(task).every(k=>allowed.includes(k)||responseOnly.includes(k)),'UNKNOWN_TASK_DEFINITION_FIELD');
  check(task.taskRoleArn?.startsWith(`arn:aws:iam::${TARGET.account}:role/`)&&task.executionRoleArn?.startsWith(`arn:aws:iam::${TARGET.account}:role/`),'ROLE_ACCOUNT_MISMATCH');
  const result=Object.fromEntries(allowed.filter(k=>k in task).map(k=>[k,structuredClone(task[k])]));
  result.family=`packproof-security-verifier-${sourceSha.slice(0,12)}-${runId}`;
  const c=result.containerDefinitions[0];
  check(!c.environmentFiles?.length&&!c.mountPoints?.length&&!c.volumesFrom?.length&&!c.dependsOn?.length&&!c.firelensConfiguration,'UNREVIEWED_CONTAINER_SIDE_EFFECTS');
  check(c.logConfiguration?.logDriver==='awslogs'&&c.logConfiguration.options?.['awslogs-group']&&c.logConfiguration.options?.['awslogs-stream-prefix'],'VERIFIER_LOG_RECEIPT_REQUIRED');
  check(c.logConfiguration.options['awslogs-region']===TARGET.region,'VERIFIER_LOG_REGION_MISMATCH');
  const names=[...(c.environment??[]),...(c.secrets??[])].map(x=>x.name);
  check(names.length===new Set(names).size,'DUPLICATE_BINDINGS');
  const env=Object.fromEntries((c.environment??[]).map(x=>[x.name,x.value]));
  check(env.PACKPROOF_MIGRATE_ON_START==='false','MIGRATIONS_MUST_REMAIN_DISABLED');
  for(const name of ['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'])check(Object.hasOwn(env,name),'RELEASE_BINDING_MISSING');
  const next={PACKPROOF_RELEASE_SHA:sourceSha,PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_VERSION:version};
  c.environment=c.environment.map(x=>Object.hasOwn(next,x.name)?{...x,value:next[x.name]}:x);
  c.image=image;c.entryPoint=[];
  // This Node process executes only the read-only script, never application main.
  c.command=['node','--input-type=module','-e',`process.argv=${JSON.stringify(['node','/tmp/security-preflight.mjs',sourceSha,inventorySha256])};\n${script}`];
  delete c.healthCheck;delete c.restartPolicy;
  check(Buffer.byteLength(JSON.stringify(c.command))<7800,'VERIFIER_COMMAND_TOO_LARGE');
  return{request:result,scriptSha256:createHash('sha256').update(script).digest('hex'),containerName:c.name,logGroup:c.logConfiguration.options['awslogs-group'],logPrefix:c.logConfiguration.options['awslogs-stream-prefix']};
}
export function runVerifierRequest(service,taskDefinitionArn,{runId,sourceSha}){
  check(sha.test(sourceSha)&&/^[0-9]{1,20}$/.test(runId),'INVALID_RUN_IDENTITY');
  check(service.serviceArn===TARGET.serviceArn&&taskDefinitionArn.startsWith(`arn:aws:ecs:${TARGET.region}:${TARGET.account}:task-definition/packproof-security-verifier-${sourceSha.slice(0,12)}-${runId}:`),'VERIFIER_TARGET_MISMATCH');
  const network=service.networkConfiguration;
  check(network?.awsvpcConfiguration?.subnets?.length&&network.awsvpcConfiguration.securityGroups?.length&&['ENABLED','DISABLED'].includes(network.awsvpcConfiguration.assignPublicIp),'NETWORK_NOT_EXPLICIT');
  check(!service.capacityProviderStrategy?.length||service.capacityProviderStrategy.every(x=>['FARGATE','FARGATE_SPOT'].includes(x.capacityProvider)),'UNREVIEWED_CAPACITY_PROVIDER');
  return{cluster:TARGET.cluster,taskDefinition:taskDefinitionArn,count:1,networkConfiguration:structuredClone(network),
    ...(service.capacityProviderStrategy?.length?{capacityProviderStrategy:structuredClone(service.capacityProviderStrategy)}:{launchType:'FARGATE'}),
    ...(service.platformVersion?{platformVersion:service.platformVersion}:{}),enableExecuteCommand:false,
    tags:[{key:'packproof-release',value:sourceSha}],
    startedBy:`pp-security-${sourceSha.slice(0,7)}-${runId}`.slice(0,36),clientToken:`${sourceSha}-${runId}`.slice(0,64)};
}
export function preservationSnapshot({service,express,taskDefinition}){
  check(express.activeConfigurations?.length===1,'AMBIGUOUS_CONFIGURATION');
  const config=express.activeConfigurations[0],container=structuredClone(config.primaryContainer);
  delete container.image;
  container.environment=(container.environment??[]).filter(x=>!['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'].includes(x.name));
  const fixedConfig=Object.fromEntries(['executionRoleArn','taskRoleArn','cpu','memory','networkConfiguration','scalingTarget','healthCheckPath'].filter(k=>k in config).map(k=>[k,config[k]]));
  const serviceSettings=Object.fromEntries(['capacityProviderStrategy','launchType','platformVersion','networkConfiguration','deploymentConfiguration','healthCheckGracePeriodSeconds','loadBalancers'].filter(k=>k in service).map(k=>[k,service[k]]));
  const taskSettings=Object.fromEntries(['taskRoleArn','executionRoleArn','networkMode','cpu','memory','runtimePlatform','ephemeralStorage','volumes','requiresCompatibilities'].filter(k=>k in taskDefinition).map(k=>[k,taskDefinition[k]]));
  const taskContainers=(taskDefinition.containerDefinitions??[]).map(c=>{
    const copy=structuredClone(c);delete copy.image;
    copy.environment=(copy.environment??[]).filter(x=>!['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION'].includes(x.name));return copy;
  });
  return{primaryContainer:hash(container),expressSettings:hash(fixedConfig),serviceSettings:hash(serviceSettings),taskSettings:hash(taskSettings),taskContainers:hash(taskContainers)};
}
