import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicProofView } from '../../web/src/api/types';
import type { SharedProofPreview } from '../src/shared/contracts';
import { ShareReviews } from '../src/main/share-review';

const scope={accountId:'seller',epoch:1},hash='a'.repeat(64);
const preview=()=>({proofId:'proof_1',status:'FINALIZED',
  disclosure:{viewHash:hash,scopeVersion:1,fields:['status','order','shipping','evidence','statements'],liveProof:true,sharingNotice:'Originals and future updates',revocationNotice:'Saved copies cannot be recalled'},
  tracker:{itemTitle:'Server-projected item',headline:'Carrier reported delivery',shipment:{carrier:'UPS'},milestones:[{code:'DELIVERED',label:'Carrier reported delivery',occurredAt:'2026-09-27T00:00:00.000Z'}]},
  evidence:[{evidenceId:'root_media',slot:'Packing',committed:true,representation:'ORIGINAL'},{evidenceId:'stage_media',stageId:'stage_1',slot:'Return receipt',committed:true,representation:'ORIGINAL'}],
} as PublicProofView & {tracker:SharedProofPreview['tracker']});

afterEach(()=>vi.useRealTimers());
describe('native sharing review authority',()=>{
 it('projects server categories, recipient summary and originals without forwarding token or owner fields',()=>{
  const reviews=new ShareReviews();const source={...preview(),token:'private_token',transaction:{buyerEmail:'private@example.invalid'},tracker:{...preview().tracker!,reference:'private_reference',shipment:{carrier:'UPS',trackingNumber:'private_tracking'},milestones:[{code:'DELIVERED',label:'Carrier reported delivery',occurredAt:null,detail:'private_detail'}]}};
  const result=reviews.issue(scope,'proof_1',source);
  expect(result.tracker?.itemTitle).toBe('Server-projected item');expect(result.evidence).toHaveLength(2);expect(result.disclosure.fields).toContain('statements');
  expect(JSON.stringify(result)).not.toContain('private_');expect(JSON.stringify(result)).not.toContain('buyerEmail');
 });
 it('binds original playback and one-time approval to account, epoch, proof and issued hash',()=>{
  const reviews=new ShareReviews();reviews.issue(scope,'proof_1',preview());
  expect(reviews.media(scope,'proof_1',hash,'stage_media')).toEqual({stageId:'stage_1'});
  expect(reviews.media(scope,'proof_1',hash,'root_media')).toEqual({stageId:undefined});
  for(const [owner,proofId,digest]of [[{accountId:'other',epoch:1},'proof_1',hash],[{...scope,epoch:2},'proof_1',hash],[scope,'proof_2',hash],[scope,'proof_1','b'.repeat(64)]] as const)expect(()=>reviews.consume(owner,proofId,digest)).toThrow(/preview/);
  expect(()=>reviews.media(scope,'proof_1',hash,'not_in_preview')).toThrow(/recording/);
  reviews.consume(scope,'proof_1',hash);expect(()=>reviews.consume(scope,'proof_1',hash)).toThrow(/preview/);
 });
 it('requires a new review after refresh, timeout, or session clearing',()=>{
  vi.useFakeTimers();const reviews=new ShareReviews();reviews.issue(scope,'proof_1',preview());
  const next=preview();next.disclosure!.viewHash='b'.repeat(64);reviews.issue(scope,'proof_1',next);
  expect(()=>reviews.consume(scope,'proof_1',hash)).toThrow(/preview/);
  vi.advanceTimersByTime(10*60_000);expect(()=>reviews.consume(scope,'proof_1',next.disclosure!.viewHash)).toThrow(/preview/);
  reviews.issue(scope,'proof_1',preview());reviews.clear();expect(()=>reviews.media(scope,'proof_1',hash,'root_media')).toThrow(/preview/);
 });
 it('rejects malformed or another Proof’s server preview',()=>{
  const reviews=new ShareReviews();expect(()=>reviews.issue(scope,'proof_2',preview())).toThrow(/valid sharing preview/);
  for(const disclosure of [undefined,{...preview().disclosure!,viewHash:'bad'},{...preview().disclosure!,liveProof:false}])expect(()=>reviews.issue(scope,'proof_1',{...preview(),disclosure})).toThrow(/valid sharing preview/);
 });
});
