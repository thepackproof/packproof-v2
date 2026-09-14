import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { useDirectUpload } from '../src/capture/upload-transport';
import { uploadCompletionConfirmed } from '../src/capture/upload-outcome';
import { recoverCaptureCompletion } from '../src/capture/recover-completion';
import { sameCaptureAccount } from '../src/capture/recovery-model';
import { localProofWork } from '../src/copy/proof-list';
import type { LocalCapture } from '../src/capture';
import type { SavedCaptureInput } from '../src/capture/completion';

// Run the actual coordinator with native I/O replaced at its boundary; the real
// recovery engine still enforces receipt, identity and server-state ordering.
function harness() {
  let finishUpload!: () => void;
  const upload = new Promise<void>(resolve => { finishUpload = resolve; });
  let didStart!: () => void;
  const started = new Promise<void>(resolve => { didStart = resolve; });
  const calls: string[] = [];
  const proof = { proofId:'proof_A', status:'READY_FOR_EVIDENCE', evidence:[] as {evidenceId:string;validationStatus:string}[] };
  const capture: LocalCapture = {uri:'file:///original-A.mp4',contentType:'video/mp4',byteSize:12000,captureSessionId:'cap_A',captureProofId:'proof_A',captureUserId:'seller'};
  const modules: Record<string, unknown> = {
    '../capture': {
      async bindRecordedCapture(_client: unknown, value:LocalCapture) { value.captureSha256 = 'digest'; },
      async inspectCaptureShipping() {},
      async persistCaptureMetadata(value:LocalCapture) { calls.push(`persist:${value.captureProofId}:${value.recovery?.phase}`); },
      async uploadCaptureFile() { calls.push('direct'); didStart(); await upload; },
      async uploadCaptureResumable() { calls.push('resumable'); didStart(); await upload; },
    },
    '../attestation/seller-attestation': {async authorizeSellerCapture() {}},
    '../v2-api': {newIdempotencyKey:()=> 'key_A'},
    './recover-completion': {recoverCaptureCompletion},
    './recovery-model': {sameCaptureAccount},
    '../analytics/native-study': {async nativeStudyForCapture() {return null;}},
    './identifier-observation': {identifierCaptureEnabled:()=>false},
    './identifier-storage': {async prepareIdentifierCheckpoint() {}},
    './upload-transport': {useDirectUpload},
    './upload-notifications': {async beginUploadService() {},async endUploadService() {},async notifyUploadOutcome() {calls.push('notify');}},
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/capture/completion.ts', import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const loaded = {exports:{} as typeof import('../src/capture/completion')};
  new Function('require','module','exports', compiled)((id:string) => {assert.ok(id in modules, id); return modules[id];}, loaded, loaded.exports);
  const client = {
    apiBaseUrl:'https://api.example.test',
    async getProof() {return structuredClone(proof);},
    async getCapabilities() {return {captureEngine:{version:1,hashProfile:'packproof-sha256-v1',durableReceipts:false}};},
    async getProofRecovery() {return {proofId:proof.proofId,evidence:proof.evidence.map(item=>({...item,status:'PRESERVED',receipt:{operationId:'p',eventSha256:'e',envelopeSha256:'h',preservedAt:'now',signature:'s'}})),finalization:{status:'PRESERVED',receipt:{operationId:'f',eventSha256:'e',envelopeSha256:'h',preservedAt:'now',signature:'s'}}};},
    async initializeEvidenceUpload() {calls.push('initialize'); return {evidenceId:'evidence_A',upload:{method:'PUT',url:'https://bucket.s3.us-east-1.amazonaws.com/original',headers:{}}};},
    async commitEvidence() {calls.push('commit');proof.status='EVIDENCE_COMMITTED';proof.evidence=[{evidenceId:'evidence_A',validationStatus:'COMMITTED'}];},
    async finalizeProof() {calls.push('finalize');proof.status='FINALIZED';},
  };
  const input = {capture,client,userId:'seller',interactive:true,needsSellerAttestation:false,assertAccount:()=>{}} as unknown as SavedCaptureInput;
  return {api:loaded.exports,input,calls,capture,proof,finishUpload,started};
}

test('preparation yields without sending bytes; another recording can prepare while the first upload is stalled', async () => {
  const h = harness();
  await h.api.prepareSavedCapture(h.input);
  assert.equal(h.calls.includes('initialize'),false);
  assert.equal(h.capture.recovery?.submitRequested,true);
  const completing = h.api.completeSavedCapture({...h.input,interactive:false});
  await h.started;
  assert.equal(h.calls.includes('notify'),false);
  const next = {...h.capture,uri:'file:///original-B.mp4',captureSessionId:'cap_B',captureProofId:'proof_B',recovery:undefined};
  await h.api.prepareSavedCapture({...h.input,capture:next});
  assert.equal(next.recovery?.proofId,'proof_B');
  h.finishUpload();
  await completing;
  assert.equal(next.recovery?.phase,'UPLOAD_QUEUED');
  assert.equal(h.capture.uri,'file:///original-A.mp4');
  assert.ok(h.calls.indexOf('notify') > h.calls.indexOf('finalize'));
  assert.equal(h.calls.filter(call=>call==='direct').length,1);
});

test('an existing evidence identity uses resumable delivery and keeps the same original', async () => {
  const h = harness(); await h.api.prepareSavedCapture(h.input);
  h.capture.uploadEvidenceId = 'evidence_A'; h.capture.recovery!.attempt = 1;
  const completing = h.api.completeSavedCapture({...h.input,interactive:false});
  await h.started; h.finishUpload(); await completing;
  assert.equal(h.calls.includes('direct'),false);assert.equal(h.calls.includes('resumable'),true);
  assert.equal(h.capture.uploadEvidenceId,'evidence_A');assert.equal(h.capture.uri,'file:///original-A.mp4');
});

test('permission/transport selection and completion cannot manufacture a saved Proof', () => {
  const target = {method:'PUT' as const,url:'https://bucket.s3.us-east-1.amazonaws.com/original',headers:{}};
  assert.equal(useDirectUpload(target,'https://api.example.test'),true);
  assert.equal(useDirectUpload({...target,url:`/upload/admission_${'a'.repeat(43)}`},'https://api.example.test'),true);
  for (const url of ['/upload/part','https://bucket.s3.amazonaws.com.attacker.test/file','http://bucket.s3.amazonaws.com/file'])
    assert.equal(useDirectUpload({...target,url},'https://api.example.test'),false);
  assert.equal(useDirectUpload({...target,received:true},'https://api.example.test'),false);
  const capture = {uploadEvidenceId:'video',recovery:{completionNotificationRequested:true,proofId:'proof',phase:'FINALIZED'}} as Parameters<typeof uploadCompletionConfirmed>[0];
  const proof = {proofId:'proof',status:'FINALIZED',evidence:[{evidenceId:'video',validationStatus:'COMMITTED'}]};
  assert.equal(uploadCompletionConfirmed(capture,proof),true);
  assert.equal(uploadCompletionConfirmed(capture,{...proof,status:'EVIDENCE_COMMITTED'}),false);
  assert.equal(uploadCompletionConfirmed(capture,{...proof,evidence:[{evidenceId:'another',validationStatus:'COMMITTED'}]}),false);
  capture.recovery.discardRequested=true;assert.equal(uploadCompletionConfirmed(capture,proof),false);
});

test('queued work is distinct from an interrupted upload or a live transfer', async () => {
  const h=harness();await h.api.prepareSavedCapture(h.input);
  assert.equal(localProofWork(h.capture)?.state,'UPLOAD_PENDING');
  assert.equal(localProofWork(h.capture,'uploading',42)?.state,'UPLOADING');
  h.capture.recovery!.lastError={code:'NETWORK',message:'Interrupted',retryable:true};
  assert.equal(localProofWork(h.capture)?.state,'UPLOAD_INTERRUPTED');
});
