import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TARGET, hash} from './backend-deployment-plan.mjs';
import {hostedCollectorTarget as target} from './reconstruction-v11-release-review.mjs';
import {connectConfigurationLease} from './connect-runtime-release.mjs';
import {observeRuntime, publicReadiness, saveObservation} from './connect-hosted-runtime-observe.mjs';

const now = Date.parse('2026-11-18T15:00:00Z');
const networkConfiguration = {awsvpcConfiguration:{
  subnets:['subnet-1234','subnet-5678'],securityGroups:['sg-abcd'],assignPublicIp:'ENABLED'
}};
function service(kind) {
  const api = kind === 'api', name = api ? TARGET.serviceName : 'packproof-records-worker';
  const source = (api ? 'a' : 'b').repeat(40), image = TARGET.repository+'@sha256:'+(api?'c':'d').repeat(64);
  const serviceArn = target.clusterArn.replace(':cluster/',':service/')+'/'+name;
  const tdArn = 'arn:aws:ecs:'+TARGET.region+':'+TARGET.account+':task-definition/'+name+':17';
  const primary = {name:kind,image,environment:Object.entries({
    PACKPROOF_ENVIRONMENT:'production',PACKPROOF_RELEASE_IMAGE:image,PACKPROOF_RELEASE_SHA:source,
    PACKPROOF_RELEASE_VERSION:kind+'-release',PACKPROOF_MIGRATE_ON_START:'false',PACKPROOF_DB_HOST:target.host,
    PACKPROOF_DB_NAME:target.database,PACKPROOF_PROCESS_ROLE:kind,PACKPROOF_TRUSTED_PROXIES:'10.20.0.0/16'
  }).map(([name,value])=>({name,value})),secrets:[{name:'PACKPROOF_DB_PASSWORD',valueFrom:'private-secret-reference'}]};
  const init = {name:'init',image};
  return {service:{serviceArn,clusterArn:target.clusterArn,status:'ACTIVE',desiredCount:1,runningCount:1,
    pendingCount:0,taskDefinition:tdArn,launchType:'FARGATE',platformVersion:'1.4.0',networkConfiguration,
    deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:tdArn}]},
  taskDefinition:{taskDefinitionArn:tdArn,family:name,status:'ACTIVE',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],
    taskRoleArn:'arn:aws:iam::'+TARGET.account+':role/runtime',executionRoleArn:'arn:aws:iam::'+TARGET.account+':role/execute',
    containerDefinitions:api ? [primary] : [init,primary]},
  tasks:[{taskArn:target.clusterArn.replace(':cluster/',':task/')+'/'+(api?'1':'2').repeat(32),clusterArn:target.clusterArn,
    group:'service:'+name,taskDefinitionArn:tdArn,desiredStatus:'RUNNING',lastStatus:'RUNNING',
    containers:[...(!api?[{name:'init',lastStatus:'STOPPED',exitCode:0,imageDigest:image.split('@')[1]}]:[]),
      {name:kind,lastStatus:'RUNNING',imageDigest:image.split('@')[1]}]}],
  ...(api?{express:{serviceArn,activeConfigurations:[{primaryContainer:structuredClone(primary)}]},
    nativeDeploymentStatus:'SUCCESSFUL',meta:{commit:source,image,version:kind+'-release'}}:{})};
}

function fixture() {
  const api=service('api'),worker=service('worker');
  const report={readOnly:true,account:TARGET.account,region:TARGET.region,service:api.service,
    express:{activeConfigurations:[{configurationSha256:hash(api.express.activeConfigurations[0]),
      primaryContainer:{trustedProxies:{configured:true,value:'10.20.0.0/16'}}}]},
    calls:['describe-express-gateway-service','describe-service-revisions','describe-target-groups','describe-load-balancers',
      'describe-load-balancer-attributes','describe-security-groups','describe-subnets'].map(operation=>({operation,status:'SUCCESS'})),
    loadBalancers:[{LoadBalancerArn:'alb1',Attributes:[{Key:'a'},{Key:'b'}]}],targetGroups:[{TargetGroupArn:'tg1'}],
    securityGroups:[{GroupId:'sg-abcd'}],subnets:[{SubnetId:'subnet-1234'},{SubnetId:'subnet-5678'}]};
  const checks={'/health':200,'/ready':200,'/me/capabilities':401};
  return {api,worker,report,checks,deps:{services:async()=>({api,worker}),discovery:async()=>report,
    readiness:async()=>checks,clock:()=>now}};
}

test('writes private runner inputs, retains distinct predecessor identities and every initializer',async t=>{
  const {deps,checks,worker} = fixture();
  const packets=await observeRuntime(deps);
  assert.deepEqual(packets.apiObservation.publicChecks,checks);
  assert.equal(packets.apiObservation.observedAt,new Date(now).toISOString());
  assert.equal(packets.workerObservation.observedAt,packets.apiObservation.observedAt);
  assert.deepEqual(packets.workerObservation.tasks,worker.tasks);
  assert.deepEqual(packets.snapshot.probe,{clusterArn:target.clusterArn,networkConfiguration,platformVersion:'1.4.0'});
  assert.match(connectConfigurationLease(packets.snapshot),/^[a-f0-9]{64}$/);
  const temp=await mkdtemp(join(tmpdir(),'packproof-observer-test-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const dir=join(temp,'private');
  await saveObservation(dir,packets);
  assert.equal((await stat(dir)).mode&0o777,0o700);
  const names=(await readdir(dir)).sort();
  assert.deepEqual(names,['api-observation.json','snapshot.json','worker-observation.json']);
  for (const name of names) assert.equal((await stat(join(dir,name))).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'snapshot.json'))),packets.snapshot);
  await assert.rejects(saveObservation(dir,packets),{code:'EEXIST'});
});
test('partial or wrong-family service state, network or inconsistent public identity fails closed',async()=>{
  for(const [change,error] of [
    [f=>f.worker.tasks[0].containers[0].exitCode=9,/LIVE_SERVICE_TASKS/],
    [f=>f.worker.service.clusterArn=target.clusterArn+'-other',/UNSTABLE_WORKER/],
    [f=>f.api.meta.version='other',/PUBLIC_VERSION_OR_SOURCE/],
    [f=>f.report.express.activeConfigurations[0].configurationSha256='0'.repeat(64),/TOPOLOGY_REVISION_CHANGED/],
    [f=>f.report.calls.push({operation:'describe-target-groups',status:'FAILED'}),/TOPOLOGY_CALL_INCOMPLETE/],
    [f=>f.worker.service.networkConfiguration={awsvpcConfiguration:{...networkConfiguration.awsvpcConfiguration,assignPublicIp:undefined}},/PROBE_NETWORK/],
    [f=>f.worker.service.launchType='EC2',/PROBE_CAPACITY/]
  ]) {
    const f=fixture();change(f);
    await assert.rejects(observeRuntime(f.deps),error);
  }
});
test('topology pins rule contents without false drift from AWS result ordering',async()=>{
  const f=fixture();
  const read=async()=>hash((await observeRuntime(f.deps)).snapshot.topology);
  const initial=await read();
  f.report.subnets.reverse();
  f.report.loadBalancers[0].Attributes.reverse();
  assert.equal(await read(),initial);
  f.report.loadBalancers[0].Attributes[0].Value='changed';
  assert.notEqual(await read(),initial);
});
test('emergency disable acquires current API without worker, readiness or topology dependency',async()=>{
  const {api}=fixture();
  const never=()=>assert.fail('unrelated resource lookup');
  const packet=await observeRuntime({apiOnly:true,services:async({apiOnly})=>{assert.equal(apiOnly,true);return {api};},
    discovery:never,readiness:never,clock:()=>now});
  assert.deepEqual(Object.keys(packet),['apiObservation']);
  assert.deepEqual(packet.apiObservation.tasks,api.tasks);
});
test('public GETs bind the fixed endpoint, website origin, readiness body and unauthorized denial',async()=>{
  const makeRequest=(options={})=>async(url,init)=>{
    const req=new URL(url);
    assert.equal(req.origin,'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws');
    assert.equal(init.headers.Origin,'https://thepackproof.com');
    assert.equal(init.redirect,'error');
    const expected={'/ready':'ready','/health':'ok','/me/capabilities':'unauthorized'};
    assert.ok(Object.hasOwn(expected,req.pathname));
    return Response.json({status:options.body??expected[req.pathname]},{
      status:req.pathname==='/me/capabilities' ? options.auth??401 : 200,
      headers:{'access-control-allow-origin':options.origin??init.headers.Origin}
    });
  };
  assert.deepEqual(await publicReadiness(makeRequest()),fixture().checks);
  for(const change of [{origin:'*'},{auth:200},{body:'unknown'}]) {
    await assert.rejects(publicReadiness(makeRequest(change)),/PUBLIC_READINESS/);
  }
});
