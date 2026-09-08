import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localProofWork, mergeProofInvitations, presentationForProof, selectProofRows } from '../src/copy/proof-list.ts';
import { DEFAULT_PROOFS_LIBRARY, normalizeRouteName, resolveBackRoute } from '../src/app/navigation.ts';
import { proofIdFromLink } from '../src/app/deep-links.ts';
import { PackProofV2Client, type ProofCollectionItem } from '../src/v2-api.ts';
const fixture = (overrides:Partial<ProofCollectionItem> = {}):ProofCollectionItem => ({proofId:'proof-a',transactionId:'txn-a',role:'SELLER',status:'READY_FOR_EVIDENCE',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-08T00:00:00Z',finalizedAt:null,transaction:{itemTitle:'Shipment A',externalReference:'ORDER-A',transactionDate:null,carrier:null,trackingNumber:null},...overrides});
test('one contract classifies recordable seller work, waiting buyers, and pending upload without false attention', () => {
  const seller = presentationForProof(fixture()); assert.equal(seller.displayStatus,'Recording needed'); assert.equal(seller.nextAction.label,'Record packing'); assert.equal(seller.needsAttention,true);
  const buyer = presentationForProof(fixture({role:'BUYER'})); assert.equal(buyer.needsAttention,false); assert.equal(buyer.share.available,false);
  const upload = presentationForProof(fixture(), 'SELLER', {state:'UPLOADING',progress:42}); assert.equal(upload.needsAttention,false);assert.equal(upload.displayStatus,'Uploading · 42%');assert.equal(upload.completed,false);
  const interrupted = presentationForProof(fixture(),'SELLER',localProofWork({interrupted:true})); assert.equal(interrupted.nextAction.label,'Review interrupted recording');assert.equal(interrupted.needsAttention,true);
});
test('All remains complete; attention sort is stable; finalization and shipment movement remain separate', () => {
  const waiting = fixture({proofId:'wait',role:'BUYER',updatedAt:'2026-09-09T00:00:00Z'});
  const completed = fixture({proofId:'complete',status:'FINALIZED',finalizedAt:'2026-09-08T00:00:00Z'});
  const rows = [waiting,completed,fixture({proofId:'proof-b'}),fixture()].map(row => ({...row,presentation:presentationForProof(row)}));
  assert.deepEqual(selectProofRows(rows,DEFAULT_PROOFS_LIBRARY).map(row=>row.proofId),['proof-a','proof-b','wait','complete']);
  assert.equal(selectProofRows(rows,{...DEFAULT_PROOFS_LIBRARY,view:'attention'}).length,2);
  assert.deepEqual(selectProofRows(rows,{...DEFAULT_PROOFS_LIBRARY,view:'completed'}).map(row=>row.proofId),['complete']);
  assert.equal(presentationForProof(fixture({status:'CANCELLED'})).completed,false);
  assert.equal(presentationForProof(fixture({status:'FINALIZED',finalizedAt:null})).completed,false);
});
test('invitation merges by canonical ID and cannot become participant work before acceptance', () => {
  const invitation = {invitationId:'invite',proofId:'proof-a',status:'PENDING',createdAt:'2026-09-01T00:00:00Z',expiresAt:null,inviter:{userId:'u',username:null,displayName:null},transaction:{transactionId:'txn-a',itemTitle:'Shipment A',externalReference:null}};
  assert.equal(mergeProofInvitations([fixture()], [invitation]).length,1);
  const item = mergeProofInvitations([], [invitation])[0]; const view = presentationForProof(item,'BUYER',{state:'UPLOADING'});
  assert.equal(view.nextAction.type,'ACCEPT_INVITATION');assert.equal(view.share.available,false);
});
test('participant deep links return to Proofs and never absorb public share or arbitrary external URLs', () => {
  assert.equal(DEFAULT_PROOFS_LIBRARY.view,'all');assert.equal(normalizeRouteName('orders'),'home');assert.equal(resolveBackRoute('proof','orders'),'home');assert.equal(resolveBackRoute('capture','station'),'proof');
  assert.equal(proofIdFromLink('packproof://proof/abc-123'),'abc-123');assert.equal(proofIdFromLink('https://thepackproof.com/app/proofs/abc'),'abc');
  assert.equal(proofIdFromLink('https://evil.example/app/proofs/abc'),null);assert.equal(proofIdFromLink('https://thepackproof.com/share/token'),null);
});
test('mobile collection traverses all pages and deduplicates overlapping pages before search', async () => {
  const client = new PackProofV2Client({baseUrl:'https://api.example',getToken:()=>null});const called:string[]=[];
  (client as unknown as {request:(path:string)=>Promise<unknown>}).request = async path => {called.push(path);return path.includes('offset=0')?{proofs:[fixture()],nextOffset:100}:{proofs:[fixture(),fixture({proofId:'later',transaction:{...fixture().transaction,itemTitle:'Rare vase'}})],nextOffset:null};};
  const result = await client.listMyProofs();assert.equal(called.length,2);assert.equal(result.proofs.length,2);
  const rows = result.proofs.map(row=>({...row,presentation:presentationForProof(row)}));assert.deepEqual(selectProofRows(rows,{...DEFAULT_PROOFS_LIBRARY,query:'rare vase'}).map(row=>row.proofId),['later']);
});

test('supporting evidence never blocks the required continuous packing recording', async () => {
  const {stationContextFromProof} = await import('../src/packing-station/display.ts');
  const proof = {...fixture({status:'EVIDENCE_COMMITTED'}),participants:[{userId:'seller',role:'SELLER'}],evidence:[{evidenceId:'support',evidenceType:'SELLER_EVIDENCE',validationStatus:'COMMITTED'}]};
  assert.equal(stationContextFromProof(proof).captureReady,true);
  proof.evidence.push({evidenceId:'packing',evidenceType:'FULFILLMENT_CAPTURE',validationStatus:'COMMITTED'});
  assert.equal(stationContextFromProof(proof).captureReady,false);
  assert.equal(stationContextFromProof({...proof,status:'FINALIZED',evidence:[]}).captureReady,false);
});

test('server-only native confirmation uses only the exact committed original owned by its seller', async () => {
  const {recoverableSellerEvidence} = await import('../src/attestation/authorization.ts');
  const proof = {...fixture(),participants:[{userId:'seller',role:'SELLER'},{userId:'buyer',role:'BUYER'}],evidence:[{evidenceId:'packing',evidenceType:'FULFILLMENT_CAPTURE',validationStatus:'COMMITTED',submittedBy:'seller',captureSessionId:'capture',captureClient:'NATIVE_CAMERA',sha256:'a'.repeat(64)}]} as unknown as import('../src/v2-api.ts').ProofView;
  assert.equal(recoverableSellerEvidence(proof,'packing','seller')?.captureSessionId,'capture');
  assert.equal(recoverableSellerEvidence(proof,'packing','buyer'),null);
  assert.equal(recoverableSellerEvidence(proof,'other','seller'),null);
  assert.equal(recoverableSellerEvidence({...proof,evidence:[{...proof.evidence[0],captureClient:'WEB_CAMERA'}]},'packing','seller'),null);
  assert.equal(recoverableSellerEvidence({...proof,evidence:[{...proof.evidence[0],validationStatus:'PENDING'}]},'packing','seller'),null);
});
