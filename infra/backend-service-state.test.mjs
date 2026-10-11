import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceWithRevision, awsFailureCode} from './backend-service-state.mjs';

test('CANARY workload settings come from the identified service revision without changing service policy', () => {
  const service = {serviceArn:'arn:known', deploymentConfiguration:{strategy:'CANARY'}, desiredCount:1, deployments:[{status:'PRIMARY',taskDefinition:'task:40'}]};
  const revision = {serviceArn:'arn:known',taskDefinition:'task:40',networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-current'],securityGroups:['sg-current'],assignPublicIp:'ENABLED'}},loadBalancers:[{targetGroupArn:'target-current'}],capacityProviderStrategy:[{capacityProvider:'FARGATE',weight:1}],platformVersion:'1.4.0'};
  const result = serviceWithRevision(service,revision);
  assert.equal(result.taskDefinition,'task:40');
  assert.deepEqual(result.networkConfiguration,revision.networkConfiguration);
  assert.deepEqual(result.deploymentConfiguration,service.deploymentConfiguration);
  assert.deepEqual(result.loadBalancers,revision.loadBalancers);
  assert.equal(service.taskDefinition,undefined);
  assert.throws(()=>serviceWithRevision(service,{...revision,serviceArn:'arn:other'}),/IDENTITY/);
  assert.throws(()=>serviceWithRevision(service,{serviceArn:'arn:known'}),/IDENTITY/);
});

test('AWS errors retain only safe diagnostic categories', () => {
  assert.equal(awsFailureCode({stderr:'An error occurred (AccessDeniedException) when calling SomeOperation: sensitive details'}),'AccessDeniedException');
  assert.equal(awsFailureCode({stderr:'Unknown options: sensitive-value'}),'CLI_ARGUMENT_ERROR');
  assert.equal(awsFailureCode({code:'ERR_INVALID_ARG_TYPE'}),'LOCAL_ARGUMENT_ERROR');
  assert.equal(awsFailureCode({stderr:'secret value must not be emitted'}),'AWS_CALL_FAILED');
});
