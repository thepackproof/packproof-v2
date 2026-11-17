import {readFileSync,writeFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {normalizedRecord,projectOrders,refKey,type Root,type StoredEvent} from '../src/records/order-projection.js';

interface Fixture {sourceId:string;sha256:string;profileVersion:string;records:unknown[]}
const artifact=process.env.PACKPROOF_JOURNEY_RECEIPT;
describe.skipIf(!artifact)('Windows reader receipts across the controlled order journey',()=>{
  it('links split and consolidated shipments, preserving quantities across labels, replays, a correction, a late relationship and a return',()=>{
    const files=JSON.parse(readFileSync(artifact!,'utf8')) as Record<string,Fixture>;
    const events:StoredEvent[]=[],roots:Root[]=[],observed=new Set<string>();
    function apply(file:string){
      const fixture=files[file];
      fixture.records.forEach(input=>{
        const record=normalizedRecord(input);
        const id=[fixture.sourceId,record.eventId,record.version].join('/');
        if(observed.has(id))return;
        observed.add(id);
        events.push({id,source_id:fixture.sourceId,record,receipt_id:file,original_sha256:fixture.sha256,file_name:file,profile_version:fixture.profileVersion,received_at:'2026-11-17T12:00:00Z'});
        if(record.kind==='order'&&!roots.some(root=>root.root_key===refKey(record.entity)))
          roots.push({proof_id:'proof-'+record.entity.id,source_id:fixture.sourceId,root_key:refKey(record.entity),order_reference:record.entity.id});
      });
      return projectOrders(events,roots);
    }
    const view=()=>projectOrders(events,roots).projections.find(p=>p.orderReference==='SO10482')!;
    apply('early_evidence.json');
    expect(roots).toHaveLength(0);
    const workbook=files['orders.xlsx'].records.map(normalizedRecord);
    expect(workbook.flatMap(record=>record.lines.map(line=>[line.lineId,line.orderedQuantity]))).toEqual([['20','2'],['30','1']]);
    apply('orders.json');
    expect(view().lines.map(l=>[l.lineId,l.orderedQuantity])).toEqual([['20','2'],['30','1']]);
    for(const file of ['picking.csv','packages.xml','packing_photo.json','labels.json']) apply(file);
    expect(view().events.filter(e=>e.kind==='handoff')).toHaveLength(0);
    expect(view().events.some(e=>e.eventId==='photo-94')).toBe(false);
    apply('handoff.json'); apply('delivery.jsonl');
    expect(view().events.filter(e=>e.kind==='delivery')).toHaveLength(2);
    expect(view().lines.map(l=>[l.lineId,l.shippedQuantity])).toEqual([['20','2'],['30','1']]);
    const before=JSON.stringify(view());
    apply('delivery.jsonl');apply('orders.json');
    expect(JSON.stringify(view())).toBe(before);
    apply('corrections.json');
    expect(view().lines.find(l=>l.lineId==='20')).toMatchObject({orderedQuantity:'3',shippedQuantity:'2'});
    apply('late_bridge.json');
    expect(view().events.some(e=>e.eventId==='photo-94')).toBe(true);
    apply('second_order.json');apply('consolidated.json');apply('return.json');
    expect(view().lines.find(l=>l.lineId==='20')).toMatchObject({returnedQuantity:'1',orderedQuantity:'3',shippedQuantity:'2'});
    const second=projectOrders(events,roots).projections.find(v=>v.orderReference==='SO10483')!;
    expect(second.lines).toEqual([expect.objectContaining({lineId:'10',shippedQuantity:'1'})]);
    expect(view().lines.map(l=>l.lineId)).toEqual(['20','30']);
    expect(view().events.some(e=>e.eventId==='handoff-second')).toBe(false);
    apply('cancellation.json');
    expect(view().lines.find(l=>l.lineId==='20')).toMatchObject({cancelledQuantity:'1',shippedQuantity:'2'});
    if(process.env.PACKPROOF_JOURNEY_PROJECTED) writeFileSync(process.env.PACKPROOF_JOURNEY_PROJECTED,JSON.stringify({...view(),revision:1}));
  });
});
