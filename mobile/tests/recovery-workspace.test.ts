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
test('grading labels keep item context outside the control',()=>{
  assert.deepEqual(proofTaskCopy('WORKFLOW_ACTION','Document item 1 of 3'),{buttonLabel:'Continue capture',reason:'Front and back photos · Item 1 of 3'});
  assert.equal(proofTaskCopy('RECORD_PACKING','Record packing').buttonLabel,'Continue capture');
});
test('local photo recovery comes before new capture and never crosses accounts',()=>{
  const f=input();f.photoDrafts=[{schema:1,id:'draft',actionKey:'action',updatedAt:'now',apiBaseUrl:f.apiBaseUrl,userId:f.userId,proofId:'two',actionType:'CAPTURE_ASSET',recipe:'CARD_STANDARD_V1',assetId:'a',transferId:null,phase:'LOCAL_ONLY',slots:[{slot:'FRONT',uri:'local',contentType:'image/jpeg',uploadKey:'key'}],retainedUris:[]}];
  const workspace=selectRecoveryWorkspace(f);assert.equal(workspace.model.recommendation.targetId,'two');assert.equal(workspace.model.recommendation.buttonLabel,'Resume photos');assert.equal(workspace.attention.length,3);
  assert.equal(selectRecoveryWorkspace({...f,userId:'other'}).model.recommendation.buttonLabel,'Continue capture');
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
  assert.equal(pending.model.recommendation.buttonLabel, 'Resume photos');
  const retained = selectRecoveryWorkspace({...f, photoDrafts:[{...draft,phase:'LOCAL_ONLY'}]});
  assert.equal(retained.model.counts.uploading, 0);
  assert.equal(retained.attention.length, 0);
});

test('submitted recordings are saved copies rather than an upload still in progress',()=>{
  assert.equal(activityGroup({ recovery: {phase:'SUBMITTED', submitRequested:true, lastError:null} }), 'completed');
  assert.equal(activityGroup({ recovery: {phase:'FINALIZED', submitRequested:true, lastError:null} }), 'completed');
});
