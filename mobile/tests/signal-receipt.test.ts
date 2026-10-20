import test from 'node:test';
import assert from 'node:assert/strict';
import {hasSignalReceipt} from '../src/experience/signal/receipt';
import {assertContinuousRecording,assertRecordingReplacement} from '../src/capture/recording-review';
import type {LocalCapture} from '../src/capture';
const receipt={operationId:'preserved-1',eventSha256:'event',envelopeSha256:'envelope',preservedAt:'2026-10-20T12:00:00Z',signature:{value:'server-signature'}};
const proof={proofId:'p1',status:'FINALIZED',finalizedAt:'2026-10-20T12:00:00Z',evidence:[{evidenceId:'e1',validationStatus:'COMMITTED'}]};
const recovery={proofId:'p1',evidence:[{evidenceId:'e1',status:'PRESERVED',receipt}],finalization:{status:'PRESERVED',receipt:{...receipt,operationId:'finalization-1'}}};
const identity={proofId:'p1',evidenceId:'e1'};
test('receipt requires canonical finalization and both matching durable server receipts',()=>{
 assert.equal(hasSignalReceipt(proof,recovery,identity),true);
 for(const changed of [{...proof,status:'EVIDENCE_COMMITTED'},{...proof,proofId:'other'},{...proof,finalizedAt:null},{...proof,evidence:[{evidenceId:'e2',validationStatus:'COMMITTED'}]}])assert.equal(hasSignalReceipt(changed,recovery,identity),false);
 for(const changed of [{...recovery,proofId:'other'},{...recovery,evidence:[]},{...recovery,finalization:{status:'PRESERVED',receipt:null}},{...recovery,finalization:{status:'PRESERVED',receipt:{operationId:'partial'}}}])assert.equal(hasSignalReceipt(proof,changed,identity),false);
});
test('a retake candidate cannot submit or start another replacement before an explicit durable choice',()=>{
 const take={uri:'file:candidate',captureProofId:'p1',contentType:'video/mp4',byteSize:100,durationMs:1000,replacement:{originalUri:'file:original',decision:'pending'}} as LocalCapture;
 assert.throws(()=>assertContinuousRecording(take),/Choose/);
 assert.throws(()=>assertRecordingReplacement(take,'p1',take.uri),/Choose/);
 assert.doesNotThrow(()=>assertContinuousRecording({...take,replacement:{...take.replacement!,decision:'accepted'}}));
 assert.throws(()=>assertContinuousRecording({...take,interrupted:true,replacement:{...take.replacement!,decision:'accepted'}}),/interrupted/);
 assert.equal(take.replacement?.originalUri,'file:original');
});
