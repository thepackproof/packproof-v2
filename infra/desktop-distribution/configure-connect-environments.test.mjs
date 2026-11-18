import test from 'node:test';
import assert from 'node:assert/strict';
import { configure, reviewPolicy, publicSettings } from './configure-connect-environments.mjs';

const stack={StackId:'arn:aws:cloudformation:us-east-1:784514617543:stack/packproof-desktop-updates/test',
  StackStatus:'UPDATE_COMPLETE',Outputs:[{OutputKey:'ActivationState',OutputValue:'ACTIVE'},
    {OutputKey:'ReleaseBucketName',OutputValue:'bucket'}, {OutputKey:'ConnectProductionPublishRoleArn',OutputValue:'arn:aws:iam::784514617543:role/packproof/connect/ConnectProductionPublisher-test'}]};
const branchPolicy={custom_branch_policies:true,protected_branches:false};
function env(name, id=7) {
  return {name,can_admins_bypass:false,deployment_branch_policy:branchPolicy, protection_rules:[
    {type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{id}}]},
    {type:'wait_timer',wait_timer:3},{type:'branch_policy'}]};
}
function mock() {
  const records=new Map(), branches=new Map(), vars=new Map(), writes=[];
  function api(method, endpoint, data) {
    if (endpoint.startsWith('environments?')) return [{environments:[...records.values()]}];
    const [,name,part,key]=endpoint.split('/'); const object=records.get(name);
    if (method!=='GET') writes.push([method,endpoint,data]);
    if (!part && method==='GET') return env(name);
    if (!part && method==='PUT') {assert.equal(object,undefined);const created=env(name);records.set(name,created);return created;}
    if (part.startsWith('deployment-branch-policies')) {
      if (method==='POST') {branches.set(name,[data]);return {};}
      return [{branch_policies:branches.get(name)||[]}];
    }
    assert.equal(part,'variables');
    if(method==='GET')return vars.get(name+'/'+key)||null;
    vars.set(name+'/'+data.name,data);return {};
  }
  return {api,records,vars,branches,writes};
}

test('previews without writes, creates protected environments, sets scoped public variables and repeats without changes',async()=>{
  const m=mock(), opts={stack,api:m.api,log:()=>{}};
  await configure(opts);assert.deepEqual(m.writes,[]);
  await configure({...opts,apply:true});
  assert.equal(m.records.size,2);
  for (const [method,name,body] of m.writes.filter(r=>r[0]==='PUT')) assert.deepEqual(body,reviewPolicy(env(name)));
  assert.equal(m.vars.size,6);
  assert.equal(m.vars.get('connect-production-publish/PACKPROOF_RELEASE_ROLE_ARN').value,stack.Outputs[2].OutputValue);
  const count=m.writes.length;
  m.records.set('connect-production',env('connect-production',99));
  await configure({...opts,apply:true});
  assert.equal(m.writes.length,count);assert.equal(reviewPolicy(m.records.get('connect-production')).reviewers[0].id,99);
});

test('limits changes to public configuration while the approved stack update is pending',async()=>{
  const m=mock();const s={...stack,Outputs:stack.Outputs.slice(0,2)};
  const result=await configure({stack:s,api:m.api,apply:true,log:()=>{}});
  assert.equal(result.publisherRoleAvailable,false);assert.equal(m.vars.size,5);
  assert.throws(()=>publicSettings({...stack,StackId:'arn:wrong-account'},true), /PackProof downloads stack/);
});

test('refuses a broader existing production policy before writing anything',async()=>{
  const m=mock();m.records.set('connect-production-publish',env('connect-production-publish'));
  m.branches.set('connect-production-publish',[{type:'tag',name:'main'}]);
  await assert.rejects(configure({stack,api:m.api,apply:true,log:()=>{}}),/branch or tag/);
  assert.deepEqual(m.writes,[]);
});
