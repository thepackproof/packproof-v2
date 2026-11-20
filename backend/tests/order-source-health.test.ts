import { describe, expect, it } from 'vitest';
import { overdueCartons, sourceCondition } from '../src/records/order-source-health.js';

const source = {id:'dispatch',generation:1,roles:['delivery'],expectedCheckIntervalSeconds:300,expectedDeliveryAfterLabelSeconds:3600};
const receipt = {kind:'delivery',entity:{type:'package',id:'CTN-01',namespace:'pack'},references:[],
  associationScope:'order',occurredAt:'2026-11-19T19:16:00Z',observedAt:'2026-11-19T19:18:00Z',eventKey:'pod1'};
const label = {...receipt,kind:'label',occurredAt:'2026-11-19T13:42:00Z',eventKey:'lbl2',entity:{...receipt.entity,id:'CTN-02'}};
describe('approved source timing rules',() => {
  it('groups a missed read and recovers on a verified read independently of the remaining carton',() => {
    const report = {source,state:'current',decided_at:'2026-11-19T12:00:00Z',verified_read_at:'2026-11-19T19:18:00Z'};
    const now = new Date('2026-11-19T19:30:00Z');
    expect(sourceCondition(report,now)).toMatchObject({state:'delayed',nextCheckAt:'2026-11-19T19:23:00.000Z'});
    const recovered = new Date('2026-11-19T19:34:00Z');
    expect(sourceCondition({...report,verified_read_at:recovered},recovered).state).toBe('current');
    expect(overdueCartons(source,[receipt,label],recovered)).toEqual([{id:'CTN-02',namespace:'pack',deadline:'2026-11-19T14:42:00.000Z'}]);
    expect(overdueCartons(source,[receipt,label,{...receipt,entity:label.entity,eventKey:'pod2'}],recovered)).toEqual([]);
  });
  it('keeps an unapproved deadline or shared label out of overdue claims',() => {
    const now = new Date('2026-11-19T19:30:00Z');
    expect(overdueCartons({...source,expectedDeliveryAfterLabelSeconds:undefined},[label],now)).toEqual([]);
    expect(overdueCartons(source,[{...label,associationScope:'shared'}],now)).toEqual([]);
    expect(sourceCondition({source:{...source,expectedCheckIntervalSeconds:undefined},state:'current',
      verified_read_at:receipt.observedAt,decided_at:receipt.occurredAt},now)).toMatchObject({state:'current',nextCheckAt:null});
  });
});
