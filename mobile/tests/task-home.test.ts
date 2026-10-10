import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTaskHome, stableRecommendation, type HomeInput, type HomeProof, type HomeCapture, type HomeJob } from '../src/experience/task-home.ts';
import { nativeHomeInput } from '../src/experience/home-adapter.ts';
import type { LocalCapture } from '../src/capture';
import { freshProofDestination, savedCaptureDestination } from '../src/experience/action-routing.ts';
import type { ProofView } from '../src/v2-api';
const proof=(id:string,overrides:Partial<HomeProof>={}):HomeProof=>({id,title:id,status:'READY_FOR_EVIDENCE',authorized:true,action:'capture',createdAt:'2026-01-01',updatedAt:'2026-01-01',completed:false,...overrides});
const input=(overrides:Partial<HomeInput>={}):HomeInput=>({proofs:[],captures:[],jobs:[],orders:[],online:true,reconciled:true,...overrides});
const capture=(id:string,proofId:string,overrides:Partial<HomeCapture>={}):HomeCapture=>({id,proofId,usable:true,needsReview:true,authorized:true,...overrides});
const job=(id:string,proofId:string,overrides:Partial<HomeJob>={}):HomeJob=>({id,proofId,authorized:true,active:false,waiting:false,intervention:true,...overrides});

test('empty and completed-only accounts recommend manual creation without a marketplace',()=>{
  assert.equal(selectTaskHome(input()).recommendation.kind,'create_proof');
  assert.equal(selectTaskHome(input({reconciled:false})).recommendation.title,'Create a Proof','a failed initial request is not proof of a new account');
  const model=selectTaskHome(input({proofs:[proof('done',{status:'FINALIZED',completed:true})]}));
  assert.equal(model.recommendation.kind,'create_proof');assert.equal(model.counts.completed,1);
});
test('pristine linked orders enter rank five while a manual draft remains rank three',()=>{
  const state=input({proofs:[proof('order'),proof('manual')],orders:[{id:'order',proofId:'order',title:'Linked shipment',ready:true,authorized:true,createdAt:'2026-01-01'}]});
  assert.deepEqual(selectTaskHome(state).actions.map(a=>[a.targetId,a.rank]),[['manual',3],['order',5]]);
  state.online=false;state.reconciled=false;
  assert.equal(selectTaskHome(state).recommendation.kind,'create_proof');
  assert.equal(selectTaskHome(state).counts.attention,2,'cached attention remains labeled as cached while authoritative actions wait');
});
test('every actionable rank wins in exact order, without mutating input',()=>{
  const state=input({proofs:[proof('review'),proof('failed'),proof('draft'),proof('final',{action:'finalize',status:'EVIDENCE_COMMITTED'}),proof('order',{action:'view'})],captures:[capture('saved','review')],jobs:[job('bad','failed')],orders:[{id:'order',proofId:'order',title:'Order',ready:true,authorized:true,createdAt:'2026-01-01'}]});
  const original=JSON.stringify(state);
  assert.deepEqual(selectTaskHome(state).actions.map(a=>a.rank),[1,2,3,4,5]);
  assert.equal(JSON.stringify(state),original);
  state.captures=[];state.proofs=state.proofs.filter(p=>p.id!=='review');assert.equal(selectTaskHome(state).recommendation.kind,'review_upload');
  state.jobs=[];state.proofs=state.proofs.filter(p=>p.id!=='failed');assert.equal(selectTaskHome(state).recommendation.kind,'continue_proof');
  state.proofs=state.proofs.filter(p=>p.id!=='draft');assert.equal(selectTaskHome(state).recommendation.kind,'finalize_proof');
  state.proofs=state.proofs.filter(p=>p.id!=='final');assert.equal(selectTaskHome(state).recommendation.kind,'start_packing');
});
test('passive uploads and retry backoff never displace a draft or count as attention',()=>{
  const model=selectTaskHome(input({proofs:[proof('upload'),proof('draft')],captures:[capture('video','upload',{needsReview:false})],jobs:[job('transfer','upload',{intervention:false,active:true}),job('retry','upload',{intervention:false,waiting:true})]}));
  assert.equal(model.recommendation.targetId,'draft');assert.deepEqual(model.counts,{attention:1,uploading:1,waiting:1,completed:0});
});
test('attention counts unique records while active transfer counts unique jobs',()=>{
  const state=input({proofs:[proof('a')],jobs:[job('1','a'),job('2','a'),job('2','a')]});
  assert.equal(selectTaskHome(state).counts.attention,1);
  state.jobs=state.jobs.map(j=>({...j,active:true,intervention:false}));assert.equal(selectTaskHome(state).counts.uploading,2);
});
test('permissions, invalid targets and finalized records exclude capture actions',()=>{
  const model=selectTaskHome(input({proofs:[proof('secret',{authorized:false}),proof('done',{status:'FINALIZED',completed:true}),proof('view',{action:'view'})],captures:[capture('s','secret'),capture('d','done'),capture('removed','deleted')],jobs:[job('missing','deleted')]}));
  assert.equal(model.actions.length,0);assert.equal(model.counts.uploading,0);
});
test('unknown or inconsistent completion requests reconciliation, never completed',()=>{
  for(const p of [proof('x',{status:'ALIEN'}),proof('x',{status:'FINALIZED',completed:false}),proof('x',{action:'unknown'})]) {
    const model=selectTaskHome(input({proofs:[p]}));assert.equal(model.recommendation.kind,'reconcile');assert.equal(model.counts.completed,0);
  }
});
test('offline permits usable local review but defers server-only work and counts waiting separately',()=>{
  const state=input({online:false,reconciled:false,proofs:[proof('local'),proof('final',{action:'finalize'})],captures:[capture('video','local')]});
  assert.equal(selectTaskHome(state).recommendation.kind,'review_evidence');
  state.captures=[];assert.equal(selectTaskHome(state).recommendation.kind,'create_proof');
  assert.match(selectTaskHome(state).recommendation.reason,/Connect/);
});
test('corrupt and interrupted captures never become review evidence',()=>{
  for(const patch of [{interrupted:true},{usable:false}]) {
    assert.equal(selectTaskHome(input({proofs:[proof('a')],captures:[capture('c','a',patch)]})).recommendation.kind,'review_upload');
  }
});
test('tie ordering is explicit selection, last interaction, oldest actionable, stable identifier',()=>{
  const state=input({proofs:[proof('z',{createdAt:'2026-02-01'}),proof('b'),proof('a')]});
  assert.equal(selectTaskHome(state).recommendation.targetId,'a');
  state.interactions={b:200,z:100};assert.equal(selectTaskHome(state).recommendation.targetId,'b');
  state.selection='z';assert.equal(selectTaskHome(state).recommendation.targetId,'z');
  assert.deepEqual(selectTaskHome({...state,proofs:[...state.proofs].reverse()}).actions,selectTaskHome(state).actions);
});
test('focused manual creation survives newly actionable work and refreshes offline explanation',()=>{
  const previous=selectTaskHome(input()).recommendation;
  const changed=input({proofs:[proof('new')],captures:[capture('saved','new')]});
  assert.equal(stableRecommendation(previous,selectTaskHome(changed),true).kind,'create_proof');
  assert.equal(stableRecommendation(previous,selectTaskHome(changed),false).kind,'review_evidence');
  changed.online=false;changed.reconciled=false;
  assert.match(stableRecommendation(previous,selectTaskHome(changed),true).reason,/Connect/);
});

test('focused recommendation stays stable only while valid; another device completion invalidates it',()=>{
  const state=input({proofs:[proof('a'),proof('b')]});const first=selectTaskHome(state).recommendation;
  state.selection='b';assert.equal(stableRecommendation(first,selectTaskHome(state),true).targetId,'a');
  state.proofs[0]=proof('a',{status:'FINALIZED',completed:true});assert.equal(stableRecommendation(first,selectTaskHome(state),true).targetId,'b');
});
test('native adapter removes foreign account/server recordings and keeps automatic retries passive',()=>{
  const row={proofId:'p',transactionId:'t',role:'SELLER',status:'READY_FOR_EVIDENCE',createdAt:'2026-01-01',updatedAt:'2026-01-01',finalizedAt:null,transaction:{itemTitle:'Item',externalReference:null,transactionDate:null,carrier:null,trackingNumber:null}};
  const local:LocalCapture={uri:'file:///a',contentType:'video/mp4',byteSize:100,durationMs:1000,captureProofId:'p',captureUserId:'user',captureSessionId:'session',recovery:{version:1,operationId:'op',apiBaseUrl:'https://api',userId:'user',proofId:'p',phase:'UPLOAD_QUEUED',evidenceIdempotencyKey:'key',submitRequested:true,needsSellerAttestation:true,attempt:1,nextRetryAt:100,lastError:{code:'NETWORK',message:'Waiting',retryable:true},updatedAt:'2026-01-01'}};
  const base={proofs:[row],invitations:[],captures:[local],orders:[],progress:{},userId:'user',apiBaseUrl:'https://api',online:true,reconciled:true};
  assert.equal(selectTaskHome(nativeHomeInput(base)).counts.attention,0);
  assert.equal(nativeHomeInput({...base,userId:'other'}).captures.length,0);
  assert.equal(nativeHomeInput({...base,apiBaseUrl:'https://different'}).jobs.length,0);
  local.interrupted=true;local.recovery!.phase='LOCAL_ONLY';local.recovery!.submitRequested=false;
  assert.equal(selectTaskHome(nativeHomeInput(base)).recommendation.kind,'review_evidence','a completed single take recovered after interruption remains reviewable');
  local.recovery!.phase='FINALIZATION_PENDING';local.recovery!.submitRequested=true;
  assert.equal(selectTaskHome(nativeHomeInput({...base,progress:{p:100}})).counts.uploading,0,'100 percent bytes is not active transfer or finalization');
});

test('tap-time routing uses refreshed permissions/state and never stale capture or finalization actions',()=>{
  const current={proofId:'p',status:'READY_FOR_EVIDENCE',workflowType:'COMMERCE_SALE',finalizedAt:null,participants:[{userId:'seller',role:'SELLER'}],evidence:[]} as unknown as ProofView;
  assert.equal(freshProofDestination(current,'seller').route,'capture');
  assert.equal(freshProofDestination({...current,status:'FINALIZED',finalizedAt:'2026-10-09'},'seller').route,'proof');
  assert.match(freshProofDestination({...current,status:'FINALIZED'},'seller').notice!,/already been finalized/);
  assert.equal(freshProofDestination(current,'unrelated-user').route,'proof');
  assert.equal(freshProofDestination({...current,status:'UNKNOWN' as any},'seller').route,'proof');
  assert.equal(freshProofDestination({...current,status:'EVIDENCE_COMMITTED',evidence:[{validationStatus:'COMMITTED',evidenceType:'FULFILLMENT_CAPTURE'}]} as ProofView,'seller').route,'finalize');
  const stage={...current,status:'FINALIZED',finalizedAt:'2026-10-09',presentation:{proofId:'p',displayStatus:'Receipt recording needed',completed:true,canContribute:true,diagnostic:null,needsAttention:true,nextAction:{type:'WORKFLOW_ACTION',label:'Record receipt'},shipmentStatus:null,share:{available:true,reason:null}}} as ProofView;
  assert.equal(freshProofDestination(stage,'seller').route,'receipt');
  const state=input({proofs:[proof('p',{status:'FINALIZED',completed:true,action:'continue',continuationAfterFinalization:true})],captures:[capture('old-root','p')]});
  const model=selectTaskHome(state);assert.equal(model.recommendation.kind,'continue_proof');assert.equal(model.counts.attention,1);assert.equal(model.counts.completed,1);
});

test('saved capture resume requires fresh capture permission; offline permits playback only',()=>{
  const current={proofId:'p',status:'READY_FOR_EVIDENCE',workflowType:'COMMERCE_SALE',finalizedAt:null,participants:[{userId:'seller',role:'SELLER'}],evidence:[]} as unknown as ProofView;
  assert.deepEqual(savedCaptureDestination(current,'seller'),{route:'capture',allowResume:true,reviewOnly:false,notice:null});
  const offline=savedCaptureDestination(null,'seller');
  assert.equal(offline.route,'capture');assert.equal(offline.reviewOnly,true);assert.equal(offline.allowResume,false);assert.match(offline.notice!,/Offline review only/);
  for(const fresh of [
    {...current,participants:[]},
    {...current,status:'UNKNOWN'},
    {...current,presentation:{canContribute:false,nextAction:{type:'RECORD_PACKING'},diagnostic:null}},
    {...current,presentation:{canContribute:true,nextAction:{type:'RECORD_PACKING'},diagnostic:'unrecognized'}},
  ] as ProofView[]) {
    const result=savedCaptureDestination(fresh,'seller');
    assert.equal(result.route,'proof');assert.equal(result.allowResume,false);assert.equal(result.reviewOnly,false);assert.match(result.notice!,/local recording is retained/);
  }
  const committed={...current,status:'EVIDENCE_COMMITTED',evidence:[{validationStatus:'COMMITTED',evidenceType:'FULFILLMENT_CAPTURE'}]} as ProofView;
  assert.equal(savedCaptureDestination(committed,'seller').route,'finalize');assert.equal(savedCaptureDestination(committed,'seller').allowResume,false);
  const finalized={...current,status:'FINALIZED',finalizedAt:'2026-10-09'} as ProofView;
  assert.equal(savedCaptureDestination(finalized,'seller').route,'proof');assert.equal(savedCaptureDestination(finalized,'seller').allowResume,false);
  const receipt={...finalized,presentation:{proofId:'p',displayStatus:'Receipt recording needed',completed:true,canContribute:true,diagnostic:null,needsAttention:true,nextAction:{type:'WORKFLOW_ACTION',label:'Record receipt'},shipmentStatus:null,share:{available:true,reason:null}}} as ProofView;
  assert.equal(savedCaptureDestination(receipt,'seller').route,'receipt');assert.equal(savedCaptureDestination(receipt,'seller').allowResume,false);
  const grading={...current,workflowType:'GRADING_SUBMISSION',nextAction:{type:'PACK_ITEMS'},presentation:{...receipt.presentation,completed:false,nextAction:{type:'WORKFLOW_ACTION',label:'Pack items'}}} as ProofView;
  assert.equal(savedCaptureDestination(grading,'seller').allowResume,true);
  assert.equal(savedCaptureDestination({...grading,nextAction:{type:'HAND_OFF'}} as ProofView,'seller').allowResume,false);
});
