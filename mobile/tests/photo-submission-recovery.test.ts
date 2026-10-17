import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverPhotoSubmission, photoRetryDue } from '../src/capture/photo-submission-recovery';
import { submitPhotoDraft, replacePhotoSlot, type PhotoDraft, type PhotoSubmissionPorts } from '../src/capture/photo-draft-model';
import { withRequestTimeout } from '../src/request-timeout';
import type { ProofView } from '../src/v2-api';

function fixture() {
  const proof={proofId:'p',status:'READY_FOR_EVIDENCE',workflowType:'GRADING_SUBMISSION',participants:[{userId:'u',role:'SELLER'}],nextAction:{type:'CAPTURE_ASSET',actorRole:'SELLER',assetId:'item',captureRecipe:'CARD_STANDARD_V1'},evidence:[]} as unknown as ProofView;
  let saved:PhotoDraft={schema:1,id:'draft',apiBaseUrl:'https://api',userId:'u',proofId:'p',actionType:'CAPTURE_ASSET',assetId:'item',transferId:null,recipe:'CARD_STANDARD_V1',actionKey:'stable-action',updatedAt:'2026-10-17',phase:'LOCAL_ONLY',retainedUris:[],slots:['FRONT','BACK'].map(slot=>({slot,uri:`file:${slot}`,contentType:'image/jpeg',uploadKey:`attempt-${slot}`}))};
  let now=1000,account=true;const calls:string[]=[];
  const assertAccount=()=>{if(!account)throw Object.assign(new Error('Account changed'),{code:'ACCOUNT_CHANGED'});};
  const persist=async(d:PhotoDraft)=>{assertAccount();saved=structuredClone(d);};
  const ports:PhotoSubmissionPorts={assertAccount,persist,getProof:async()=>proof,fileExists:async()=>true,
    initialize:async slot=>{calls.push('init:'+slot.uploadKey);return {evidenceId:'e-'+slot.slot,upload:{}};},
    upload:async slot=>{calls.push('upload:'+slot.uploadKey);},
    commit:async id=>{calls.push('commit:'+id);const receipt={evidenceId:id,validationStatus:'COMMITTED',sha256:'a'.repeat(64)};proof.evidence.push(receipt as ProofView['evidence'][number]);return receipt;},
    apply:async draft=>{calls.push('apply:'+draft.actionKey);proof.nextAction={...proof.nextAction!,type:'CAPTURE_PACKING',captureRecipe:'PACKING_STANDARD_V1'};},
  };
  const run=(manual=false)=>recoverPhotoSubmission(structuredClone(saved),{assertAccount,read:async()=>structuredClone(saved),persist,submit:d=>submitPhotoDraft(d,ports),now:()=>now},manual);
  return {ports,proof,calls,run,get:()=>structuredClone(saved),set:(d:PhotoDraft)=>{saved=structuredClone(d);},advance:()=>{now+=60_000;},switchAccount:()=>{account=false;}};
}
test('automatic recovery never submits merely selected photos',async()=>{const f=fixture();await f.run();assert.equal(f.get().phase,'LOCAL_ONLY');assert.deepEqual(f.calls,[]);});
test('a deliberate save automatically commits both photos and applies the same item action',async()=>{const f=fixture();const done=await f.run(true);assert.equal(done.phase,'COMPLETE');assert.equal(f.get().retry,undefined);assert.deepEqual(f.calls.filter(c=>c.startsWith('apply:')),['apply:stable-action']);assert.equal(f.proof.nextAction?.captureRecipe,'PACKING_STANDARD_V1');});
test('restart after a lost commit receipt reuses persisted identities and does not resend committed bytes',async()=>{
 const f=fixture(),commit=f.ports.commit;let lose=true;
 f.ports.commit=async id=>{const r=await commit(id);if(lose){lose=false;throw Object.assign(new Error('Lost response'),{code:'REQUEST_TIMEOUT'});}return r;};
 await assert.rejects(f.run(true));const durable=JSON.parse(JSON.stringify(f.get()));assert.equal(durable.phase,'SUBMITTING');assert.equal(durable.slots[0].evidenceId,'e-FRONT');
 f.set(durable);f.advance();assert.equal(photoRetryDue(f.get(),100_000),true);await f.run();
 assert.equal(f.get().phase,'COMPLETE');assert.equal(f.calls.filter(c=>c==='upload:attempt-FRONT').length,1);assert.equal(f.get().actionKey,'stable-action');
});
test('restart after a lost workflow response replays only its action key after the item advances',async()=>{
 const f=fixture(),apply=f.ports.apply;let lose=true;
 f.ports.apply=async(d,a)=>{await apply(d,a);if(lose){lose=false;throw Object.assign(new Error('Lost acknowledgment'),{code:'TIMEOUT'});}};
 await assert.rejects(f.run(true));f.set(JSON.parse(JSON.stringify(f.get())));f.advance();await f.run();
 assert.equal(f.get().phase,'COMPLETE');assert.equal(f.calls.filter(c=>c.startsWith('upload:')).length,2);assert.deepEqual(f.calls.filter(c=>c.startsWith('apply:')),['apply:stable-action','apply:stable-action']);
});
test('real timeout helper releases the pending item step; late completion cannot mark the draft complete',async()=>{
 const f=fixture();let finish!:()=>void;
 f.ports.apply=()=>withRequestTimeout(()=>new Promise<void>(r=>{finish=r;}),5);
 await assert.rejects(f.run(true),/too long/);assert.equal(f.get().phase,'SUBMITTING');finish();await Promise.resolve();assert.equal(f.get().phase,'SUBMITTING');assert.equal(f.get().retry?.retryable,true);
});
test('automatic retry is bounded and manual checking restarts the same durable intent',async()=>{
 const f=fixture();f.ports.getProof=async()=>{throw Object.assign(new Error('Offline'),{code:'NETWORK'});};
 await assert.rejects(f.run(true));for(let i=0;i<2;i++){f.advance();await assert.rejects(f.run());}
 assert.equal(f.get().retry?.attempts,3);assert.equal(photoRetryDue(f.get(),Infinity),false);assert.match(f.get().retry!.message,/Check/);
 await f.run();assert.equal(f.get().retry?.attempts,3);await assert.rejects(f.run(true));assert.equal(f.get().retry?.attempts,1);assert.equal(f.get().actionKey,'stable-action');
});
test('permission failures pause automatic retries and retain originals',async()=>{
 const f=fixture();f.ports.getProof=async()=>{throw Object.assign(new Error('Access changed'),{status:403});};await assert.rejects(f.run(true));assert.equal(f.get().retry?.retryable,false);assert.equal(f.get().slots.length,2);assert.equal(photoRetryDue(f.get(),Infinity),false);
});

test('a response from another Proof cannot advance or initialize a photo submission',async()=>{
 const f=fixture();f.proof.proofId='other';await assert.rejects(f.run(true),/another Proof/);
 assert.deepEqual(f.calls,[]);assert.equal(f.get().phase,'SUBMITTING');assert.equal(f.get().retry?.retryable,false);
});

test('retry refuses a changed server upload identity for the same capture attempt',async()=>{
 const f=fixture(),d=f.get();d.phase='SUBMITTING';d.slots[0].evidenceId='original-id';f.set(d);
 await assert.rejects(f.run(),/identity changed/);assert.equal(f.get().slots[0].evidenceId,'original-id');assert.equal(f.calls.some(c=>c.startsWith('upload:')),false);
});
test('account changes do not write retry success or continue the old command',async()=>{
 const f=fixture();f.ports.upload=async()=>f.switchAccount();await assert.rejects(f.run(true),/Account changed/);assert.equal(f.get().phase,'SUBMITTING');assert.equal(f.calls.some(c=>c.startsWith('commit:')),false);
});
test('replacement rejects reused attempt IDs, reused files, and committed originals',()=>{
 const f=fixture(),d=f.get(),old=d.slots[0];
 assert.throws(()=>replacePhotoSlot(d,{...old,uri:'file:new'},'now'),/identity/);
 assert.throws(()=>replacePhotoSlot(d,{...old,uploadKey:'new'},'now'),/identity/);
 assert.throws(()=>replacePhotoSlot({...d,slots:[{...old,evidenceId:'committed'},d.slots[1]]},{...old,uri:'file:new',uploadKey:'new'},'now'),/submitted/);
 const next=replacePhotoSlot(d,{...old,uri:'file:new',uploadKey:'new'},'now');assert.deepEqual(next.retainedUris,['file:FRONT']);assert.equal(next.slots.find(s=>s.slot==='FRONT')?.uploadKey,'new');
});
