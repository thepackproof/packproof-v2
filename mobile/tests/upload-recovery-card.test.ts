import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadRecoveryPresentation as card, resolveSavedCaptureUri} from '../src/capture/upload-recovery';
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
test('an app container move preserves owned recording references without rebasing arbitrary paths',()=>{
  const root='file:///new/documents/';
  assert.equal(resolveSavedCaptureUri('file:///old/documents/packproof-captures/cap_123/video.mp4',root),root+'packproof-captures/cap_123/video.mp4');
  assert.equal(resolveSavedCaptureUri('file:///old/documents/packproof-evidence-123.mp4',root),root+'packproof-evidence-123.mp4');
  assert.equal(resolveSavedCaptureUri('file:///old/other.mp4',root),null);
  assert.equal(resolveSavedCaptureUri(root+'../private.mp4',root),null);
});
