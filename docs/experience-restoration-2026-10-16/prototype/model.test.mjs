import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRecord,requiredViews,derive,fileState,transition,scenario} from './model.mjs';
const event=(r,type,fields={})=>({proofId:r.id,sessionId:r.sessionId,type,...fields});

test('ordinary sales never invent a required photo task',()=>assert.deepEqual(requiredViews(makeRecord()),[]));
test('grading front/back acceptance advances only after durable local acceptance',()=>{
  let r=makeRecord('grading','GRADING_SUBMISSION');
  assert.equal(transition(r,event(r,'PHOTO_ACCEPTED',{view:'FRONT',durable:false})),r);
  r=transition(r,event(r,'PHOTO_ACCEPTED',{view:'FRONT',durable:true}));
  assert.deepEqual(derive(r).remaining,['BACK']);
  r=transition(r,event(r,'PHOTO_ACCEPTED',{view:'BACK',durable:true}));
  assert.equal(derive(r).kind,'photos-submit');
  assert.equal(derive(r).savedCount,0);
});
test('partial item acknowledgment is file specific',()=>{
  let r=makeRecord('grading','GRADING_SUBMISSION');
  for(const view of ['FRONT','BACK'])r=transition(r,event(r,'PHOTO_ACCEPTED',{view,durable:true}));
  r=transition(r,event(r,'PHOTO_COMMIT_ACK',{ids:[r.photos[0].id]}));
  assert.equal(derive(r).savedCount,1); assert.equal(derive(r).localCount,1); assert.equal(r.finalized,false);
});
test('file commitment cannot silently accept the grading workflow step',()=>{
  let r=makeRecord('grading','GRADING_SUBMISSION');
  for(const view of ['FRONT','BACK'])r=transition(r,event(r,'PHOTO_ACCEPTED',{view,durable:true}));
  r=transition(r,event(r,'PHOTO_COMMIT_ACK',{ids:r.photos.map(p=>p.id)}));
  assert.equal(derive(r).kind,'photos-finishing');
  r=transition(r,event(r,'PHOTO_TASK_ACK'));
  assert.equal(derive(r).kind,'packing');
});
test('local recording is never server success',()=>{
  const r=scenario('review');assert.equal(derive(r).kind,'review');assert.equal(derive(r).savedCount,0);
  assert.equal(fileState(r.recording).label,'Saved on this device');
});
test('required declaration is explicit and false by default',()=>{
  const r=scenario('review'); assert.equal(r.declaration,false);assert.equal(transition(r,event(r,'SUBMIT')),r);
});
test('transfer, artifact acknowledgment and finalization are separate',()=>{
  let r=scenario('upload');
  r=transition(r,event(r,'TRANSFER_COMPLETE'));
  assert.equal(derive(r).kind,'finishing'); assert.equal(r.finalized,false); assert.equal(r.recording.local,true);
  assert.equal(transition(r,event(r,'FINALIZATION_ACK')),r);
  assert.equal(transition(r,event(r,'ARTIFACT_ACK',{artifactId:'other'})),r);
  r=transition(r,event(r,'ARTIFACT_ACK',{artifactId:r.recording.id}));
  assert.equal(derive(r).savedCount,1);assert.equal(r.finalized,false);
  r=transition(r,event(r,'FINALIZATION_ACK'));
  assert.equal(derive(r).kind,'complete');assert.equal(r.recording.local,true);
});
test('late callback remains on its Proof and session',()=>{
  const a=scenario('upload'),b=makeRecord('other');
  assert.equal(transition(b,event(a,'TRANSFER_COMPLETE')),b);
  assert.equal(transition(a,event(a,'TRANSFER_COMPLETE',{sessionId:'old'})),a);
});
test('participant wait does not negate saved evidence',()=>{
  const r=scenario('saved');assert.equal(derive(r).kind,'complete');assert.match(derive(r).participant,/Your evidence is saved/);
});
test('offline originals and remote persistence are independent',()=>{
  assert.match(fileState({committed:true,local:false},true).detail,/Connect/);
  assert.equal(fileState({committed:true,local:false},true).label,'Saved to PackProof');
  assert.match(fileState({committed:false,local:false}).label,/capture device/);
});
test('offline transfer never advances through artificial progress',()=>{
  const r=scenario('recovery');assert.equal(transition(r,event(r,'TRANSFER_PROGRESS',{percent:100})),r);
  assert.equal(derive(r).title,'Waiting for connection');
});
test('interruptions stop recording and disclose continuity loss',()=>{
  let r=makeRecord();r=transition(r,event(r,'RECORD_START'));r=transition(r,event(r,'INTERRUPT'));
  assert.equal(r.active,false);assert.equal(derive(r).kind,'interrupted');assert.match(derive(r).hint,/cannot be described as continuous/);
});
test('finalized recordings and photos cannot be silently replaced',()=>{
  const r=scenario('saved');assert.equal(transition(r,event(r,'RECORD_START')),r);
  assert.equal(transition(r,event(r,'PHOTO_ACCEPTED',{view:'FRONT',durable:true})),r);
});
test('unknown response exposes reconciliation, preserving the original',()=>{
  let r=scenario('upload');r=transition(r,event(r,'UNKNOWN_RESPONSE'));assert.equal(derive(r).action,'Check save status');
  assert.equal(r.recording.local,true);assert.equal(r.finalized,false);
});
