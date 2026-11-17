import {describe,it,expect} from 'vitest';
import {normalizedRecord,projectOrders,refKey,type StoredEvent,type Root} from '../src/records/order-projection.js';
const ref=(type:string,id:string,namespace='TEST')=>({type,id,namespace});
const A=ref('order','SO10482','ERP_A'),B=ref('order','SO10483','ERP_A'),S1=ref('shipment','SHP771'),S2=ref('shipment','SHP772'),P1=ref('package','PKG92'),P2=ref('package','PKG93');
const roots:Root[]=[A,B].map(x=>({proof_id:'proof'+x.id,source_id:'ERP',root_key:refKey(x),order_reference:x.id}));
const qty=(lineId:string,name:string,value:string)=>({lineId,sku:lineId==='10'?'B200':'A100',[name]:value,unit:'each'});
function row(source:string,eventId:string,kind:string,entity:typeof A,references:typeof A[],lines:unknown[]=[],version='1'):StoredEvent{
 const id=source+'-'+eventId+'-'+version;
 return {id,source_id:source,record:normalizedRecord({eventId,version,kind,entity,references,lines,fields:{},locator:'$.report[0]'}),receipt_id:'receipt-'+id,profile_version:'journey/v1',original_sha256:'1'.repeat(64),file_name:source+'.json',received_at:'2026-11-17T12:00:00Z'};
}
const origins=[row('ERP','a','order',A,[],[qty('20','orderedQuantity','2'),qty('30','orderedQuantity','1')]),row('ERP','b','order',B,[],[qty('10','orderedQuantity','1')])];
describe('source relationships and exact order allocations',()=>{
 it('keeps consolidated shipment references and return allocations scoped to their own orders',()=>{
  const shared=row('POD','loaded','handoff',ref('event','depart'),[S1]);
  const photos=row('CAM','p1','evidence',ref('artifact','photo'),[P1]);
  const all=[...origins,shared,photos,
   row('PACK','package1','packing',P1,[S1,A],[qty('20','packedQuantity','2')]),
   row('PACK','package2','packing',P2,[S2,A],[qty('30','packedQuantity','1')]),
   row('TMS','s1a','handoff',S1,[A],[qty('20','shippedQuantity','2')]),
   row('TMS','s1b','handoff',S1,[B],[qty('10','shippedQuantity','1')]),
   row('TMS','s2a','handoff',S2,[A],[qty('30','shippedQuantity','1')]),
   row('RET','r','return',ref('return','RMA771'),[A,P1],[qty('20','returnedQuantity','1')])];
  const normal=projectOrders(all,roots),reordered=projectOrders([...all].reverse(),roots);
  expect(reordered.projections).toEqual(normal.projections);
  const [first,second]=normal.projections;
  expect(first.lines).toEqual([expect.objectContaining({lineId:'20',orderedQuantity:'2',packedQuantity:'2',shippedQuantity:'2',returnedQuantity:'1'}),expect.objectContaining({lineId:'30',orderedQuantity:'1',shippedQuantity:'1'})]);
  expect(second.lines).toEqual([expect.objectContaining({lineId:'10',orderedQuantity:'1',shippedQuantity:'1'})]);
  expect(first.events.find(x=>x.eventId==='loaded')?.associationScope).toBe('shared');
  expect(second.events.find(x=>x.eventId==='loaded')?.associationScope).toBe('shared');
  expect(second.events.some(x=>x.kind==='return'||x.kind==='evidence')).toBe(false);
  expect(normal.members.get(photos.id)).toEqual([first.proofId]);
 });
 it('retains provisional evidence until an explicit bridge and isolates bare or reused tracking values',()=>{
  const ns1='CARRIER / ACCOUNT / 2025',ns2='CARRIER / ACCOUNT / 2026';
  const label=(namespace:string,order:typeof A)=>row('LABEL',namespace,'label',ref('tracking','001',namespace),[order]);
  const early=row('POD','early','delivery',ref('event','d'),[ref('tracking','001',ns1)]);
  const bare=row('CAM','unscoped','evidence',ref('artifact','x'),[ref('tracking','001','CARRIER')]);
  const before=projectOrders([early,...origins],roots);
  expect(before.members.get(early.id)).toEqual([]);
  const after=projectOrders([early,bare,...origins,label(ns1,A),label(ns2,B),label('CARRIER',B)],roots);
  expect(after.members.get(early.id)).toEqual([roots[0].proof_id]);expect(after.members.get(bare.id)).toEqual([]);
 });
 it('compares source versions, preserves explicit clears, and never adds repeated cumulative snapshots',()=>{
  const first=row('ERP','a','order',A,[],[qty('20','orderedQuantity','2'),qty('30','orderedQuantity','1')]);
  const newer=row('ERP','a','order',A,[],[{lineId:'20',orderedQuantity:'3',sku:null}], '3');
  const delayed=row('ERP','a','order',A,[],[{lineId:'20',orderedQuantity:'1'}], '2');
  const pick=row('WMS','q','picking',ref('warehouse','WO771'),[A],[qty('20','pickedQuantity','2')]);
  const again=row('WMS','q','picking',ref('warehouse','WO771'),[A],[qty('20','pickedQuantity','2')],'2');delete again.record.lines[0].sku;delete pick.record.lines[0].sku;
  const result=projectOrders([newer,again,delayed,pick,first],[roots[0]]).projections[0];
  expect(result.lines).toEqual([{lineId:'20',sku:null,unit:'each',orderedQuantity:'3',pickedQuantity:'2'},{lineId:'30',sku:'A100',unit:'each',orderedQuantity:'1'}]);
  expect(result.events).toHaveLength(2);expect(result.evidence).toHaveLength(5);
 });
 it('compares only matched order and shipment claims in the same known unit, with exact decimal arithmetic',()=>{
  const line=(id:string,field:string,value:string|null,unit?:string)=>({lineId:id,[field]:value,...(unit===undefined?{}:{unit})});
  const ordered=(id:string,value:string|null,unit?:string)=>line(id,'orderedQuantity',value,unit);
  const shipped=(id:string,value:string|null,unit?:string)=>line(id,'shippedQuantity',value,unit);
  const orders=row('ERP','a','order',A,[],[ordered('large','999999999999999999.123456789','kg'),ordered('over','0','kg'),
   ordered('equal','2.00','EA'),ordered('clear',null,'EA'),ordered('blank','','EA'),ordered('missing','1','EA'),
   ordered('units','2','kg'),ordered('unknown','2','EA'),ordered('conflict','3','EA')]);
  const shipment=row('WH','s','handoff',S1,[A],[shipped('large','999999999999999999.123456788','kg'),shipped('over','1.25','kg'),
   shipped('equal','2','EA'),shipped('clear','0','EA'),shipped('blank','1','EA'),shipped('units','1','lb'),
   shipped('unknown','1'),shipped('conflict','1','EA')]);
  const disputed=row('SECOND','x','handoff',S1,[A],[shipped('conflict','2','EA')]);
  const view=projectOrders([orders,shipment,disputed],[roots[0]]).projections[0];
  const lines=Object.fromEntries(view.lines.map(l=>[l.lineId,l]));
  expect(lines.large).toMatchObject({orderedMinusShippedQuantity:'0.000000001',orderedShippedDiscrepancy:'0.000000001 kg more ordered than shipped'});
  expect(lines.over).toMatchObject({orderedMinusShippedQuantity:'-1.25',orderedShippedDiscrepancy:'1.25 kg more shipped than ordered'});
  expect(lines.equal.orderedMinusShippedQuantity).toBe('0');
  expect(lines.equal.orderedShippedDiscrepancy).toBeUndefined();
  for(const id of ['clear','blank','missing','units','unknown','conflict']){
   expect(lines[id].orderedMinusShippedQuantity).toBeUndefined();
   expect(lines[id].orderedShippedDiscrepancy).toBeUndefined();
  }
 });
 it('adds exact fractional allocations only within matching units and reports competing source claims',()=>{
  const events=[...origins,row('WH','x','packing',P1,[A],[{lineId:'20',packedQuantity:'0.1',unit:'kg'}]),row('WH','y','packing',P2,[A],[{lineId:'20',packedQuantity:'0.2',unit:'kg'}])];
  expect(projectOrders(events,roots).projections[0].lines[0].packedQuantity).toBe('0.3');
  events[3].record.lines[0].unit='lb';
  const result=projectOrders(events,roots).projections[0];expect(result.lines[0].packedQuantity).toBeUndefined();expect(result.conflicts).toContain('20: packedQuantity units');
 });
});
