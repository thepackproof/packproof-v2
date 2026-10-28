import {describe,expect,it} from 'vitest';
import {parsePartnerOrderItems} from '../src/platform/partner-order-items.js';

describe('strict partner order line items',()=>{
 it('retains every authoritative line field with deterministic positions and explicit major-unit amounts',()=>{
  expect(parsePartnerOrderItems([
   {externalItemId:'line-1',title:'Widget A',description:'Blue',sku:'A',quantity:2,unitValue:12.3456,currency:'USD'},
   {externalItemId:'line-2',position:9,title:'Widget B'}
  ])).toEqual([
   {externalItemId:'line-1',position:1,title:'Widget A',description:'Blue',sku:'A',quantity:2,unitValue:12.3456,currency:'USD'},
   {externalItemId:'line-2',position:9,title:'Widget B',description:null,sku:null,quantity:1,unitValue:null,currency:null}
  ]);
  expect(parsePartnerOrderItems(undefined)).toEqual([]);
 });
 it.each([
  null,{},[],Array.from({length:101},()=>({title:'Too many'})),
  [{title:'A',externalItemId:'same'},{title:'B',externalItemId:'same'}],
  [{title:'A',position:1},{title:'B',position:1}],
  [{title:'A',position:0}],[{title:'A',position:1.5}],
  [{title:'A',quantity:0}],[{title:'A',quantity:100001}],
  [{title:'A',quantity:1.5}],[{title:'A',quantity:'2'}],
  [{title:'A',unitValue:1.23456,currency:'USD'}],
  [{title:'A',unitValue:1}],[{title:'A',unitValue:-1,currency:'USD'}],
  [{title:'A',unitValue:Infinity,currency:'USD'}],
  [{title:'A',unitValue:Number.MAX_SAFE_INTEGER,currency:'USD'}],
  [{title:'A',unitValue:1,currency:'usd'}],
  [{title:'A',actorUserId:'invented-operator'}],
  [{title:''}],[{title:'A',sku:'x'.repeat(121)}]
 ].map(value=>({value})))('rejects malformed, ambiguous or silently rounded item data %#',({value})=>{
  expect(()=>parsePartnerOrderItems(value)).toThrow();
 });
 it('preserves zero values and supports non-two-decimal currencies without exponent conversion',()=>{
  expect(parsePartnerOrderItems([{title:'Free sample',unitValue:0,currency:'JPY'}])[0]).toMatchObject({unitValue:0,currency:'JPY'});
  expect(parsePartnerOrderItems([{title:'Three-decimal display',unitValue:1.234,currency:'KWD'}])[0]).toMatchObject({unitValue:1.234,currency:'KWD'});
 });
});
