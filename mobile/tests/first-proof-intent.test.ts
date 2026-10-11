import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTaskIntent,taskIntent,taskIntentKey,pendingLinkKey} from '../src/experience/task-intent.ts';

test('task locators round-trip receiving, viewer, capture and account-targeted invitation without conversion',()=>{
  for(const route of ['proof','receipt','signature','capture','finalize'] as const){
    const input=taskIntent(route,'proof_123',1,{historyShareId:route==='signature'?'share_123':undefined});
    assert.deepEqual(parseTaskIntent(JSON.stringify(input)),input);
    assert.equal(input?.route,route);assert.equal(input?.proofId,'proof_123');
  }
  const invitation=taskIntent('invitation','proof_123',1,{invitationId:'invite_123'});
  assert.equal(invitation?.invitationId,'invite_123');
  assert.equal(parseTaskIntent(JSON.stringify({version:1,flowVersion:1,route:'invitation'})),null);
});
test('new-task and queue routes never retain an unrelated selected proof',()=>{
  for(const route of ['create','manual','orders','activity']){
    const intent=taskIntent(route,'proof_previous',1);
    assert.ok(intent);assert.equal(intent.proofId,undefined);assert.equal(intent.route,route);
  }
});
test('storage projection rejects invalid routes and strips secrets and arbitrary properties',()=>{
  for(const patch of [{version:2},{flowVersion:99},{route:'auto_finalize'},{proofId:'https://other/record'},{proofId:'../private'},{historyShareId:'x?token=secret'}]){
    assert.equal(parseTaskIntent(JSON.stringify({version:1,flowVersion:1,route:'proof',proofId:'proof_123',...patch})),null);
  }
  const parsed=parseTaskIntent(JSON.stringify({version:1,flowVersion:1,route:'proof',proofId:'proof_123',password:'secret',token:'secret',code:'secret',submitRequested:true}));
  assert.deepEqual(parsed,{version:1,flowVersion:1,route:'proof',proofId:'proof_123'});
  assert.equal(parseTaskIntent('invalid'),null);
});
test('task keys isolate accounts and environments and normalize trailing slashes',()=>{
  assert.equal(taskIntentKey('https://api/','one'),taskIntentKey('https://api','one'));
  assert.notEqual(taskIntentKey('https://api','one'),taskIntentKey('https://api','two'));
  assert.notEqual(taskIntentKey('https://api','one'),taskIntentKey('https://other','one'));
  assert.notEqual(pendingLinkKey('https://api'),pendingLinkKey('https://other'));
  assert.notEqual(pendingLinkKey('https://api'),taskIntentKey('https://api','one'));
});
test('rollback preserves stored operation flow identity while locators remain compatible',()=>{
  for(const version of [0,1] as const){const saved=taskIntent('capture','proof_123',version);assert.equal(parseTaskIntent(JSON.stringify(saved))?.flowVersion,version);}
});
