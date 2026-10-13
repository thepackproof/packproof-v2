import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoContextKey, photoDraftContext, photoDraftRemaining, replacePhotoSlot, submitPhotoDraft, type PhotoDraft, type PhotoSubmissionPorts } from '../src/capture/photo-draft-model.ts';
import type { ProofView } from '../src/v2-api';

function fixture() {
  const proof = { proofId:'p1', status:'READY_FOR_EVIDENCE', workflowType:'GRADING_SUBMISSION', participants:[{userId:'seller',role:'SELLER'}],
    nextAction:{type:'CAPTURE_ASSET',actorRole:'SELLER',assetId:'a1',captureRecipe:'CARD_STANDARD_V1'}, evidence:[] } as unknown as ProofView;
  const context=photoDraftContext(proof,'seller','https://api.example/')!;
  const draft:PhotoDraft={...context,schema:1,id:'draft',actionKey:'action-original',phase:'LOCAL_ONLY',updatedAt:'2026-10-13',retainedUris:[],slots:[
    {slot:'FRONT',uri:'front-original',contentType:'image/jpeg',uploadKey:'front-key'},
    {slot:'BACK',uri:'back-original',contentType:'image/jpeg',uploadKey:'back-key'}]};
  const calls:string[]=[];let saved=structuredClone(draft),account=true;
  const ports:PhotoSubmissionPorts={
    assertAccount:()=>{if(!account)throw new Error('ACCOUNT_CHANGED');},getProof:async()=>proof,
    persist:async row=>{saved=structuredClone(row);calls.push('persist');},fileExists:async()=>true,
    initialize:async row=>{calls.push('initialize:'+row.uploadKey);return{evidenceId:'e-'+row.slot,upload:{}};},
    upload:async row=>{calls.push('upload:'+row.slot);},
    commit:async id=>{calls.push('commit:'+id);proof.evidence.push({evidenceId:id,validationStatus:'COMMITTED',sha256:'a'.repeat(64),committedAt:'2026-10-13'} as ProofView['evidence'][number]);return{evidenceId:id,sha256:'a'.repeat(64)};},
    apply:async row=>{calls.push('action:'+row.actionKey);},
  };
  return {proof,draft,ports,calls,saved:()=>saved,changeAccount:()=>{account=false;}};
}
test('photo scope includes account, API, Proof, item, transfer, recipe and actor action',()=>{
  const {proof,draft}=fixture();
  assert.equal(photoContextKey(draft),photoContextKey({...draft,apiBaseUrl:draft.apiBaseUrl+'/'}));
  for(const field of ['userId','apiBaseUrl','proofId','assetId','transferId','recipe','actionType'] as const)
    assert.notEqual(photoContextKey(draft),photoContextKey({...draft,[field]:'different'}));
  assert.equal(photoDraftContext(proof,'buyer','https://api.example'),null);
  assert.equal(photoDraftContext({...proof,status:'FINALIZED'},'seller','https://api.example'),null);
  assert.equal(photoDraftContext({...proof,nextAction:{...proof.nextAction!,actorRole:'BUYER'}},'seller','https://api.example'),null);
});
test('retaking preserves the previous source and selects a new stable upload identity',()=>{
  const {draft}=fixture();const next=replacePhotoSlot(draft,{...draft.slots[0],uri:'front-retake',uploadKey:'retake-key'},'now');
  assert.deepEqual(next.retainedUris,['front-original']);assert.equal(next.slots.find(s=>s.slot==='FRONT')?.uploadKey,'retake-key');
  assert.equal(draft.slots[0].uri,'front-original');assert.equal(photoDraftRemaining(next),0);
});
test('retaking cannot change a started submission or mix in another recipe slot',()=>{
  const {draft}=fixture();
  assert.throws(()=>replacePhotoSlot({...draft,phase:'SUBMITTING'},draft.slots[0],'now'));
  assert.throws(()=>replacePhotoSlot(draft,{...draft.slots[0],slot:'OTHER'},'now'));
});
test('the complete flow persists before sending bytes and requires acknowledged workflow completion',async()=>{
  const f=fixture();const result=await submitPhotoDraft(f.draft,f.ports);
  assert.equal(result.phase,'COMPLETE');assert.equal(result.slots.length,2);
  assert.ok(result.slots.every(s=>s.sha256));assert.deepEqual(result.slots.map(s=>s.uri),['front-original','back-original']);
  assert.ok(f.calls.indexOf('persist')<f.calls.indexOf('initialize:front-key'));
  assert.ok(f.calls.indexOf('action:action-original')>f.calls.indexOf('commit:e-BACK'));
});
test('incomplete selection and a missing original never submit a workflow action',async()=>{
  const f=fixture();await assert.rejects(submitPhotoDraft({...f.draft,slots:f.draft.slots.slice(0,1)},f.ports));
  assert.equal(f.calls.length,0);f.ports.fileExists=async()=>false;
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/unavailable/);assert.equal(f.calls.some(s=>s.startsWith('action:')),false);
});
test('upload failure retains draft and retry uses the same identities',async()=>{
  const f=fixture();let fail=true;const upload=f.ports.upload;
  f.ports.upload=async(slot,target)=>{if(fail){fail=false;throw new Error('NETWORK');}await upload(slot,target);};
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/NETWORK/);
  assert.equal(f.saved().phase,'SUBMITTING');assert.equal(f.saved().slots[0].uri,'front-original');
  await submitPhotoDraft(f.saved(),f.ports);
  assert.equal(f.calls.filter(s=>s==='initialize:front-key').length,2);
  assert.equal(f.calls.filter(s=>s==='commit:e-FRONT').length,1);
});
test('lost commit response reconciles server evidence without uploading it again',async()=>{
  const f=fixture();let fail=true;const commit=f.ports.commit;
  f.ports.commit=async id=>{const value=await commit(id);if(fail){fail=false;throw new Error('TIMEOUT');}return value;};
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/TIMEOUT/);
  const done=await submitPhotoDraft(f.saved(),f.ports);assert.equal(done.phase,'COMPLETE');
  assert.equal(f.calls.filter(s=>s==='upload:FRONT').length,1);assert.equal(f.calls.filter(s=>s==='commit:e-FRONT').length,1);
});
test('lost action response can replay its original key after the next item advances',async()=>{
  const f=fixture();let fail=true;const apply=f.ports.apply;
  f.ports.apply=async(draft,action)=>{await apply(draft,action);if(fail){fail=false;f.proof.nextAction={...f.proof.nextAction!,assetId:'a2'};throw new Error('TIMEOUT');}};
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/TIMEOUT/);
  await submitPhotoDraft(f.saved(),f.ports);
  assert.equal(f.calls.filter(s=>s==='action:action-original').length,2);assert.equal(f.calls.filter(s=>s.startsWith('upload:')).length,2);
});
test('changed item or role cannot start a fresh submission',async()=>{
  const f=fixture();f.proof.nextAction={...f.proof.nextAction!,assetId:'a2'};
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/permitted step changed/);assert.equal(f.calls.length,0);
});
test('incomplete server acknowledgment does not show completion or apply a workflow action',async()=>{
  const f=fixture();f.ports.commit=async evidenceId=>({evidenceId,sha256:null});
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/receipt is incomplete/);
  assert.equal(f.saved().phase,'SUBMITTING');assert.equal(f.calls.some(s=>s.startsWith('action:')),false);
});
test('account switch during upload stops before commitment or UI success',async()=>{
  const f=fixture();f.ports.upload=async()=>f.changeAccount();
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/ACCOUNT_CHANGED/);
  assert.equal(f.calls.some(s=>s.startsWith('commit:')||s.startsWith('action:')),false);assert.equal(f.saved().phase,'SUBMITTING');
});
test('a persist failure before network submission is fail-closed',async()=>{
  const f=fixture();f.ports.persist=async()=>{throw new Error('STORAGE_FULL');};
  await assert.rejects(submitPhotoDraft(f.draft,f.ports),/STORAGE_FULL/);assert.equal(f.calls.length,0);
});
