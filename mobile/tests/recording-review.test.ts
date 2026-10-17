import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRecordingReplacement, assertContinuousRecording, requiresRecordingRecovery } from '../src/capture/recording-review';
import type { LocalCapture } from '../src/capture';
const take={uri:'file:original',captureProofId:'proof-a',contentType:'video/mp4',byteSize:120,durationMs:3000} as LocalCapture;
test('Back and camera reopen cannot implicitly replace the retained original',()=>{
 assert.throws(()=>assertRecordingReplacement(take,'proof-a'),/explicitly choose Retake/);
 assert.throws(()=>assertRecordingReplacement(take,'proof-b',take.uri),/original Proof/);
 assert.throws(()=>assertRecordingReplacement(take,'proof-a','file:other'),/explicitly/);
 assert.doesNotThrow(()=>assertRecordingReplacement(take,'proof-a',take.uri));assert.equal(take.uri,'file:original');
});
test('submission locks prevent replacement even with a confirmed local path',()=>{
 for(const capture of [{...take,uploadEvidenceId:'e'},{...take,recovery:{submitRequested:true}}] as LocalCapture[])assert.throws(()=>assertRecordingReplacement(capture,'proof-a',take.uri),/submission/);
});
test('interrupted and missing originals are inspectable recovery, never accepted as continuous packing',()=>{
 for(const capture of [{...take,interrupted:true},{...take,localFileAvailable:false},{...take,recovery:{phase:'RECORDING'}}] as LocalCapture[]){assert.equal(requiresRecordingRecovery(capture),true);assert.throws(()=>assertContinuousRecording(capture),/interrupted/);assert.equal(capture.uri,take.uri);}
 assert.doesNotThrow(()=>assertContinuousRecording(take));
});
