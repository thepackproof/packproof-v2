import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadRecoveryPresentation as card, resolveSavedCaptureUri, captureProgressLabel} from '../src/capture/upload-recovery';
test('only an active transfer claims Uploading; recovery controls stay obvious',()=>{
  const base={available:true,active:false,offline:false,accepted:true};
  assert.equal(card({...base,active:true}).title,'Uploading');
  assert.deepEqual([card(base).title,card(base).resume,card(base).discard],['Upload interrupted','Resume upload','Discard recording']);
  assert.equal(card({...base,offline:true}).title,'Waiting for connection');
  assert.equal(card({...base,failed:true}).title,'Upload failed');
  const missing=card({...base,available:false});assert.equal(missing.title,'Upload could not be completed');assert.equal(missing.resume,null);assert.equal(missing.discard,'Discard incomplete evidence');
  assert.equal(card({...base,committed:true,available:false}).discard,null);
  assert.equal(card({...base,discarding:true}).resume,null);
});
test('offline unconfirmed and interrupted captures never promise automatic submission',()=>{
  const local={available:true,active:false,offline:true,accepted:false};
  assert.equal(card(local).resume,'Review recording');
  assert.match(card(local).message,/confirm submission/);
  assert.doesNotMatch(card(local).message,/retry when/);
  const interrupted=card({...local,incomplete:true});
  assert.equal(interrupted.resume,null);
  assert.equal(interrupted.discard,'Discard incomplete recording');
  assert.match(interrupted.message,/playable recording has not been confirmed/);
  assert.equal(card({...local,available:false,incomplete:true}).discard,'Discard incomplete evidence');
});
test('transferred bytes, commitment and finalization are distinct milestones',()=>{
  assert.equal(captureProgressLabel('uploading',42),'Uploading · 42%');
  assert.equal(captureProgressLabel('uploading',100),'Bytes transferred · waiting for server commitment');
  assert.equal(captureProgressLabel('uploaded',100),'Bytes transferred · waiting for server commitment');
  assert.equal(captureProgressLabel('committed',100),'Evidence committed · checking the next step');
  for(const status of ['preparing','uploading','uploaded','committed','unknown']) assert.doesNotMatch(captureProgressLabel(status,100),/finalized|sealed|complete/i);
});
test('an app container move preserves owned recording references without rebasing arbitrary paths',()=>{
  const root='file:///new/documents/';
  assert.equal(resolveSavedCaptureUri('file:///old/documents/packproof-captures/cap_123/video.mp4',root),root+'packproof-captures/cap_123/video.mp4');
  assert.equal(resolveSavedCaptureUri('file:///old/documents/packproof-evidence-123.mp4',root),root+'packproof-evidence-123.mp4');
  assert.equal(resolveSavedCaptureUri('file:///old/other.mp4',root),null);
  assert.equal(resolveSavedCaptureUri(root+'../private.mp4',root),null);
});
