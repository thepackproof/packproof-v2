import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRecoveryWorkspace, type RecoveryWorkspaceInput } from '../src/experience/recovery-workspace.ts';
import { proofTaskCopy } from '../src/experience/home-adapter.ts';
import { selectProofRows } from '../src/copy/proof-list.ts';
import { DEFAULT_PROOFS_LIBRARY } from '../src/app/navigation.ts';
import type { ProofCollectionItem } from '../src/v2-api';
import { activityGroup } from '../src/experience/activity-model.ts';
import type { PhotoDraft } from '../src/capture/photo-draft-model.ts';
const proof=(id:string):ProofCollectionItem=>({proofId:id,transactionId:id,role:'SELLER',status:'READY_FOR_EVIDENCE',createdAt:'2026-10-13',updatedAt:'2026-10-13',finalizedAt:null,transaction:{itemTitle:id}} as ProofCollectionItem);
const input=():RecoveryWorkspaceInput=>({proofs:[proof('one'),proof('two'),proof('three')],invitations:[],captures:[],orders:[],progress:{},userId:'seller',apiBaseUrl:'https://api.example',online:true,reconciled:true});
test('three actionable Proofs and no recordings produces three tasks and zero uploads everywhere',()=>{
  const workspace=selectRecoveryWorkspace(input());
  assert.equal(workspace.model.counts.attention,3);assert.equal(workspace.attention.length,3);assert.equal(workspace.model.counts.uploading,0);
  assert.equal(selectProofRows(workspace.rows,{...DEFAULT_PROOFS_LIBRARY,view:'attention'}).length,3);
});
test('cached action counts agree with destination filters but navigation still requires fresh authorization',()=>{
  const workspace=selectRecoveryWorkspace({...input(),online:false,reconciled:false});
  assert.equal(workspace.model.counts.attention,3);assert.equal(workspace.attention.length,3);
  assert.equal(workspace.model.actions.length,0);assert.equal(workspace.model.recommendation.buttonLabel,'View saved Proof');
  assert.equal(workspace.model.recommendation.sourceFreshness,'cached');
});
test('waiting buyer and authoritative completed Proofs are not misclassified as actionable',()=>{
  const f=input();f.proofs=[{...proof('buyer'),role:'BUYER'}, {...proof('done'),status:'FINALIZED',finalizedAt:'2026-10-13'}];
  const result=selectRecoveryWorkspace(f);assert.equal(result.attention.length,0);assert.equal(result.model.counts.completed,1);
});
test('grading copy preserves the server action without guessing its photo recipe',()=>{
  assert.deepEqual(proofTaskCopy('WORKFLOW_ACTION','Document item 1 of 3'),{buttonLabel:'Document item 1 of 3',reason:'Capture the front and back of this item.'});
  assert.equal(proofTaskCopy('RECORD_PACKING','Record packing').buttonLabel,'Record packing');
});
test('local photo recovery comes before new capture and never crosses accounts',()=>{
  const f=input();f.photoDrafts=[{schema:1,id:'draft',actionKey:'action',updatedAt:'now',apiBaseUrl:f.apiBaseUrl,userId:f.userId,proofId:'two',actionType:'CAPTURE_ASSET',recipe:'CARD_STANDARD_V1',assetId:'a',transferId:null,phase:'LOCAL_ONLY',slots:[{slot:'FRONT',uri:'local',contentType:'image/jpeg',uploadKey:'key'}],retainedUris:[]}];
  const workspace=selectRecoveryWorkspace(f);assert.equal(workspace.model.recommendation.targetId,'two');assert.equal(workspace.model.recommendation.buttonLabel,'Resume item photos');assert.equal(workspace.attention.length,3);
  assert.equal(selectRecoveryWorkspace({...f,userId:'other'}).model.recommendation.buttonLabel,'Record packing');
});

test('pending photo submissions count as uploads and finalized local-only drafts do not demand new capture',()=>{
  const f = input();
  const draft: PhotoDraft = { schema:1, id:'draft', actionKey:'action', updatedAt:'now', apiBaseUrl:f.apiBaseUrl,
    userId:f.userId, proofId:'one', actionType:'CAPTURE_ASSET', recipe:'CARD_STANDARD_V1', assetId:'a',
    transferId:null, phase:'SUBMITTING', slots:[], retainedUris:[] };
  f.proofs = [{...proof('one'), status:'FINALIZED', finalizedAt:'2026-10-13'}];
  f.photoDrafts = [draft];
  const pending = selectRecoveryWorkspace(f);
  assert.equal(pending.model.counts.uploading, 1);
  assert.equal(pending.attention.length, 1);
  assert.equal(pending.model.recommendation.buttonLabel, 'Check photo submission');
  const retained = selectRecoveryWorkspace({...f, photoDrafts:[{...draft,phase:'LOCAL_ONLY'}]});
  assert.equal(retained.model.counts.uploading, 0);
  assert.equal(retained.attention.length, 0);
});

test('submitted recordings are saved copies rather than an upload still in progress',()=>{
  assert.equal(activityGroup({ recovery: {phase:'SUBMITTED', submitRequested:true, lastError:null} }), 'completed');
  assert.equal(activityGroup({ recovery: {phase:'FINALIZED', submitRequested:true, lastError:null} }), 'completed');
});


test('front and back advance to submission and accepted photos stop advertising recovery',()=>{
  const f = input();
  const draft:PhotoDraft = {schema:1,id:'photos',actionKey:'accept-photos',updatedAt:'2026-10-16',apiBaseUrl:f.apiBaseUrl,userId:f.userId,proofId:'two',actionType:'CAPTURE_ASSET',recipe:'CARD_STANDARD_V1',assetId:'card',transferId:null,phase:'LOCAL_ONLY',slots:[{slot:'FRONT',uri:'front',contentType:'image/jpeg',uploadKey:'front'}],retainedUris:[]};
  f.photoDrafts=[draft];
  assert.equal(selectRecoveryWorkspace(f).model.recommendation.buttonLabel,'Resume item photos');
  draft.slots.push({slot:'BACK',uri:'back',contentType:'image/jpeg',uploadKey:'back'});
  const complete=selectRecoveryWorkspace(f);
  assert.equal(complete.model.recommendation.buttonLabel,'Review and submit photos');
  assert.equal(complete.rows.find(row=>row.proofId==='two')?.presentation.nextAction.label,'Review and submit photos');
  assert.doesNotMatch(complete.model.recommendation.reason,/remaining|missing/);
  draft.phase='SUBMITTING';
  assert.equal(selectRecoveryWorkspace(f).model.recommendation.buttonLabel,'Check photo submission');
  draft.phase='COMPLETE';
  assert.equal(selectRecoveryWorkspace(f).photoDrafts.length,0);
  assert.equal(selectRecoveryWorkspace(f).rows.find(row=>row.proofId==='two')?.presentation.nextAction.label,'Record packing');
});

test('a failed recording takes priority over a complete photo draft on another Proof',()=>{
  const f=input();
  f.photoDrafts=[{schema:1,id:'photos',actionKey:'accept',updatedAt:'2026-10-16',apiBaseUrl:f.apiBaseUrl,userId:f.userId,proofId:'two',actionType:'CAPTURE_ASSET',recipe:'CARD_STANDARD_V1',assetId:'card',transferId:null,phase:'LOCAL_ONLY',slots:['FRONT','BACK'].map(slot=>({slot,uri:slot,contentType:'image/jpeg',uploadKey:slot})),retainedUris:[]}];
  f.captures=[{uri:'file:///failed',contentType:'video/mp4',captureProofId:'one',captureUserId:f.userId,captureSessionId:'failure',recovery:{version:1,operationId:'operation',apiBaseUrl:f.apiBaseUrl,userId:f.userId,proofId:'one',phase:'NEEDS_ATTENTION',evidenceIdempotencyKey:'key',submitRequested:true,needsSellerAttestation:true,attempt:1,lastError:{code:'REJECTED',message:'Review upload',retryable:false},updatedAt:'2026-10-13'}}];
  assert.equal(selectRecoveryWorkspace(f).model.recommendation.targetId,'one');
});
