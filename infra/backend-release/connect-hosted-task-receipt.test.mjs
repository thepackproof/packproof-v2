import test from 'node:test';
import assert from 'node:assert/strict';
import {collectTaskReceipt} from './connect-hosted-task-receipt.mjs';
import {hostedCollectorTarget as target} from './reconstruction-v11-release-review.mjs';

function data(mode){
  const taskArn=target.clusterArn.replace(':cluster/',':task/')+'/'+'1'.repeat(32),owner=mode==='inspect',previous=mode.startsWith('previous-');
  const family='packproof-connect-'+(owner?'owner-':'probe-')+'abc123abc123-'+mode;
  const kind=mode.replace(/^previous-/,''),name=owner?'owner':kind,digest='sha256:'+'a'.repeat(64);
  const td=target.clusterArn.split(':cluster/')[0]+':task-definition/'+family+':3';
  const primary={name,image:target.repository+'@'+digest,environment:owner?[]:[{name:'PACKPROOF_PROCESS_ROLE',value:kind}],
    logConfiguration:{logDriver:'awslogs',options:{'awslogs-region':'us-east-1','awslogs-stream-prefix':'connect','awslogs-group':'/ecs/packproof'}}};
  const registered={taskDefinitionArn:td,family,containerDefinitions:[primary]};
  const task={taskArn,clusterArn:target.clusterArn,lastStatus:'STOPPED',taskDefinitionArn:td,containers:[{name,imageDigest:digest,exitCode:0}]};
  const report=owner?{schema:'packproof.hosted-collector-owner-receipt/v1',actualTask:taskArn,mode}:
    previous?{event:'shipment_rollback_reader',taskArn,kind}:{schema:'packproof.reconstruction-runtime-preflight/v11-hosted',taskIdentity:{taskArn},kind};
  const messages=[{message:'starting'},{message:JSON.stringify(report)}];
  const read=(service,op,args)=>{
    if(op==='describe-tasks')return {tasks:[task],failures:[]};
    if(op==='describe-task-definition')return {taskDefinition:registered};
    assert.equal(op,'get-log-events');
    assert.equal(args[3],'connect/'+name+'/'+'1'.repeat(32));
    return {events:messages};
  };
  return {taskArn,registered,task,report,messages,read};
}

test('collects the actual registered definition, stopped task and exactly one receipt from the process log stream',()=>{
  for(const mode of ['inspect','api','previous-worker']){
    const f=data(mode);
    assert.deepEqual(collectTaskReceipt(f.taskArn,f.read),{registered:f.registered,task:f.task,report:f.report});
    f.messages.push(f.messages[1]);
    assert.throws(()=>collectTaskReceipt(f.taskArn,f.read),/ONE_COMPLETED_REPORT/);
  }
});

test('rejects task overrides and a substituted container digest before reading any receipt',()=>{
  const f=data('inspect');f.task.overrides={containerOverrides:[{name:'owner',command:['other']}]};
  assert.throws(()=>collectTaskReceipt(f.taskArn,f.read),/SUCCESSFUL_TASK/);
  delete f.task.overrides;f.task.containers[0].imageDigest='sha256:'+'f'.repeat(64);
  assert.throws(()=>collectTaskReceipt(f.taskArn,f.read),/DEFINITION_IMAGE/);
});

test('the Logistics task family accepts only the corresponding schema 129 owner receipt',()=>{
  const fixture=data('inspect');
  const original=fixture.registered.family;
  fixture.registered.family=original.replace('connect-owner','logistics-owner');
  fixture.task.taskDefinitionArn=fixture.registered.taskDefinitionArn=fixture.registered.taskDefinitionArn.replace(original,fixture.registered.family);
  assert.throws(()=>collectTaskReceipt(fixture.taskArn,fixture.read),/ONE_COMPLETED_REPORT/);
  fixture.report.schema='packproof.hosted-logistics-owner-receipt/v1';
  fixture.messages[1]={message:JSON.stringify(fixture.report)};
  assert.deepEqual(collectTaskReceipt(fixture.taskArn,fixture.read).report,fixture.report);
});
