import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRequest,verifierTaskDefinition,runVerifierRequest,preservationSnapshot} from './backend-release-requests.mjs';
import {TARGET} from './backend-deployment-plan.mjs';
const sourceSha='b'.repeat(40),image=`${TARGET.repository}@sha256:${'b'.repeat(64)}`,runId='12345';
const input={sourceSha,image,version:'release',runId,inventorySha256:'a'.repeat(64),script:readFileSync(new URL('./backend-database-preflight.mjs',import.meta.url),'utf8')};
function task(){return{family:'current',taskDefinitionArn:'current:50',revision:50,status:'ACTIVE',registeredBy:'arn:example',cpu:'2048',memory:'4096',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],taskRoleArn:`arn:aws:iam::${TARGET.account}:role/CurrentRuntime`,executionRoleArn:`arn:aws:iam::${TARGET.account}:role/CurrentExecution`,runtimePlatform:{cpuArchitecture:'X86_64',operatingSystemFamily:'LINUX'},volumes:[],containerDefinitions:[{name:'packproof-api',image:'old',environment:[{name:'PACKPROOF_MIGRATE_ON_START',value:'false'},{name:'PACKPROOF_RELEASE_SHA',value:'a'.repeat(40)},{name:'PACKPROOF_RELEASE_IMAGE',value:'old'},{name:'PACKPROOF_RELEASE_VERSION',value:'old'},{name:'PRIVATE_VALUE',value:'must-not-emit'}],secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'existing-runtime-ref'}],logConfiguration:{logDriver:'awslogs',options:{'awslogs-group':'existing','awslogs-region':'us-east-1','awslogs-stream-prefix':'api'}},healthCheck:{command:['CMD-SHELL','curl localhost']},restartPolicy:{enabled:true},command:['node','dist/index.js']}]} }
test('unique build source, exact commit/tag, optional actual version only',()=>{
 const r=buildRequest({sourceSha,zipSha256:'a'.repeat(64),buildspec:'reviewed'});
 assert.equal(r.sourceLocationOverride,`packproof-v2-staging-build-${TARGET.account}/security-release/${sourceSha}/${'a'.repeat(64)}/backend.zip`);
 assert.equal(r.environmentVariablesOverride[1].value,`security-${sourceSha}`);
 assert.equal(Object.hasOwn(r,'sourceVersion'),false);
 assert.equal(buildRequest({sourceSha,zipSha256:'a'.repeat(64),buildspec:'reviewed',sourceVersion:'actual-version'}).sourceVersion,'actual-version');
 assert.throws(()=>buildRequest({sourceSha,zipSha256:'a'.repeat(64),buildspec:'reviewed',sourceVersion:'null'}));
});
test('verifier preserves current role/resource/credential boundary and never starts application',()=>{
 const before=task(),copy=structuredClone(before),v=verifierTaskDefinition(before,input);
 assert.deepEqual(before,copy);assert.equal(v.request.cpu,'2048');assert.equal(v.request.memory,'4096');
 assert.equal(v.request.taskRoleArn,before.taskRoleArn);assert.equal(v.request.executionRoleArn,before.executionRoleArn);
 assert.deepEqual(v.request.containerDefinitions[0].secrets,before.containerDefinitions[0].secrets);
 assert.deepEqual(v.request.containerDefinitions[0].entryPoint,[]);
 assert.equal(Object.hasOwn(v.request.containerDefinitions[0],'healthCheck'),false);
 assert.equal(Object.hasOwn(v.request.containerDefinitions[0],'restartPolicy'),false);
 assert.equal(v.request.containerDefinitions[0].command[0],'node');
 assert.equal(v.request.containerDefinitions[0].command.join(' ').includes('dist/index.js'),false);
 assert.equal(v.request.family,`packproof-security-verifier-${sourceSha.slice(0,12)}-${runId}`);
 assert.ok(Buffer.byteLength(JSON.stringify(v.request.containerDefinitions[0].command))<7800);
});
for(const[name,mutate]of[
 ['sidecar',t=>t.containerDefinitions.push(structuredClone(t.containerDefinitions[0]))],
 ['volume',t=>t.volumes.push({name:'customer-data'})],
 ['envfile',t=>t.containerDefinitions[0].environmentFiles=[{type:'s3',value:'unknown'}]],
 ['wrong role account',t=>t.taskRoleArn='arn:aws:iam::000000000000:role/Runtime'],
 ['unknown field',t=>t.unknown='not-silently-dropped'],
 ['wrong network',t=>t.networkMode='bridge'],
 ['duplicate binding',t=>t.containerDefinitions[0].secrets.push({name:'PACKPROOF_RELEASE_SHA',valueFrom:'unknown'})],
 ['automatic migration',t=>t.containerDefinitions[0].environment[0].value='true']
])test(`verifier rejects ${name}`,()=>{const t=task();mutate(t);assert.throws(()=>verifierTaskDefinition(t,input));});
test('RunTask retains actual network and count is one without service mutation',()=>{
 const service={serviceArn:TARGET.serviceArn,networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-known'],securityGroups:['sg-known'],assignPublicIp:'DISABLED'}},capacityProviderStrategy:[{capacityProvider:'FARGATE',weight:1}],platformVersion:'1.4.0'};
 const arn=`arn:aws:ecs:${TARGET.region}:${TARGET.account}:task-definition/packproof-security-verifier-${sourceSha.slice(0,12)}-${runId}:1`;
 const r=runVerifierRequest(service,arn,input);assert.deepEqual(r.networkConfiguration,service.networkConfiguration);assert.equal(r.count,1);assert.equal(r.enableExecuteCommand,false);assert.equal(Object.hasOwn(r,'service'),false);assert.equal(Object.hasOwn(r,'launchType'),false);
 assert.throws(()=>runVerifierRequest(service,'wrong-task',input));
});
test('preservation ignores only image and release identity, detects origin, secret, roles, resources and scaling drift',()=>{
 const t=task(),service={deploymentConfiguration:{strategy:'CANARY'},networkConfiguration:{subnet:'known'}},config={cpu:'2048',memory:'4096',scalingTarget:{minTaskCount:3,maxTaskCount:5},primaryContainer:structuredClone(t.containerDefinitions[0])},s={service,taskDefinition:t,express:{activeConfigurations:[config]}},base=preservationSnapshot(s);
 config.primaryContainer.image=image;config.primaryContainer.environment.find(x=>x.name==='PACKPROOF_RELEASE_SHA').value=sourceSha;
 assert.deepEqual(preservationSnapshot(s),base);
 for(const mutate of [s=>s.express.activeConfigurations[0].primaryContainer.environment.push({name:'PACKPROOF_WEB_ORIGINS',value:'changed'}),s=>s.express.activeConfigurations[0].primaryContainer.secrets[0].valueFrom='wrong',s=>s.taskDefinition.taskRoleArn='wrong',s=>s.express.activeConfigurations[0].memory='1024',s=>s.express.activeConfigurations[0].scalingTarget.minTaskCount=1]){const changed=structuredClone(s);mutate(changed);assert.notDeepEqual(preservationSnapshot(changed),base);}
});
