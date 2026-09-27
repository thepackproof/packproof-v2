import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Auth } from '../src/renderer/Auth';
import { PackingStation } from '../src/renderer/PackingStation';
import { SharePreviewContents, ShareProof } from '../src/renderer/ShareProof';
import { appearsTracking, filterFulfillmentOrders, presentation, trackingMatch } from '../src/renderer/presentation';
import type { FulfillmentQueueItem, ProofCollectionItem, SystemView } from '../src/shared/contracts';

const system:SystemView={version:'1.0.0',platform:'darwin',environment:'staging',online:true,configured:false,secureStorage:false,pendingOtherAccounts:false,update:{state:'idle'},settings:{cameraId:'',microphoneId:'',audio:false,resolution:'1080p',frameRate:30,retentionHours:24,notifications:true,scannerSuffix:'Enter',theme:'system'}};
describe('desktop renderer safety and shared presentation',()=>{
  it('disables sign-in when protected storage or environment configuration is absent',()=>{
    const html=renderToStaticMarkup(<Auth system={system} onSignedIn={()=>{}}/>);
    expect(html).toContain('Protected credential storage is unavailable');
    expect(html).toContain('has not been configured');
    expect(html).toMatch(/class="primary full" disabled=""/);
    expect(html).not.toContain('value="Bearer');
  });
  it('offers no enabled record action before the camera and a Proof are ready',()=>{
    const html=renderToStaticMarkup(<PackingStation proofId={null} orders={[]} settings={system.settings} chooseProof={()=>{}} onBusy={()=>{}} onSaved={()=>{}} onSettings={()=>{}}/>);
    expect(html).toContain('Camera needs attention');
    expect(html).toMatch(/class="primary" disabled=""/);
    expect(html).toContain('Select a synchronized order');
    expect(html).not.toContain('Secured by PackProof');
  });
  it('uses the backend shipping normalization and never accepts a partial tracking match',()=>{
    const tracking='9400111899223856928877';
    expect(trackingMatch(`]C142043054\u001d${tracking}`,tracking)).toBe(true);
    expect(trackingMatch(`420430540001${tracking}`,tracking)).toBe(true);
    expect(trackingMatch(tracking,tracking.slice(2))).toBe(false);
    expect(trackingMatch('1Z999AA10123456784','1Z999AA10123456785')).toBe(false);
    expect(trackingMatch('', '')).toBe(false);
    expect(appearsTracking('012345678905')).toBe(false);
  });
  it('does not label an unfinalized record complete from status alone',()=>{
    const proof={proofId:'proof-a',status:'FINALIZED',role:'SELLER',finalizedAt:null} as ProofCollectionItem;
    expect(presentation(proof).completed).toBe(false);
    expect(presentation({...proof,finalizedAt:'2026-09-27T00:00:00Z'}).completed).toBe(true);
  });
  it('filters fulfillment by joined tracking, started evidence, and inclusive local dates',()=>{
    const base={proofId:'p1',externalOrderId:'1048',externalReference:null,itemSummary:'Collector shipment',provider:'shopify',proofStatus:'READY_FOR_EVIDENCE',evidenceCount:1,orderedAt:'2026-09-27T12:00:00'} as FulfillmentQueueItem;
    const orders=[base,{...base,proofId:'p2',evidenceCount:0},{...base,proofId:'p3',proofStatus:'FINALIZED'},{...base,proofId:'p4',orderedAt:null}];
    const proofs=[{proofId:'p1',transaction:{trackingNumber:'9400111899223856928877'}}] as ProofCollectionItem[];
    const filter={marketplace:'shopify',state:'started',search:'94001118',from:'2026-09-27',to:'2026-09-27'};
    expect(filterFulfillmentOrders(orders,proofs,filter).map(row=>row.proofId)).toEqual(['p1']);
    expect(filterFulfillmentOrders(orders,proofs,{...filter,from:'2026-09-28',to:'2026-09-28'})).toHaveLength(0);
    expect(filterFulfillmentOrders(orders,proofs,{...filter,state:'completed',search:''}).map(row=>row.proofId)).toEqual(['p3']);
  });
  it('renders actual recipient categories, item status, milestones and lifecycle originals before sharing',()=>{
    const html=renderToStaticMarkup(<SharePreviewContents disabled={false} open={()=>{}} preview={{proofId:'p1',status:'FINALIZED',disclosure:{viewHash:'a'.repeat(64),scopeVersion:1,fields:['order','shipping','evidence'],liveProof:true,revocationNotice:'Cannot recall saved copies'},tracker:{itemTitle:'Public server item',headline:'Carrier reported delivery',shipment:{carrier:'USPS'},milestones:[{code:'DELIVERED',label:'Public delivery milestone',occurredAt:'2026-09-27T00:00:00Z'}]},evidence:[{evidenceId:'stage_evidence',stageId:'return_stage',slot:'Return receipt',committed:true,representation:'ORIGINAL',label:'Original return recording'}]}}/>);
    for(const text of ['Public server item','Carrier reported delivery','Public delivery milestone','Order details','Original return recording','Review original'])expect(html).toContain(text);
    const initial=renderToStaticMarkup(<ShareProof id="p1" onClose={()=>{}}/>);
    expect(initial).toContain('Loading the current recipient preview');expect(initial).not.toContain('Share link created');expect(initial).not.toContain('checked=""');
  });
});
