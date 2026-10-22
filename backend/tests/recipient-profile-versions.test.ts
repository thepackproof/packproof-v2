import {describe,it,expect} from 'vitest';
import {recipientProfile,RECIPIENT_PROFILES,validateRecipientFiles} from '../src/export/recipient-profiles.js';
import {listRecipientProfiles} from '../src/domain/recipient-exports.js';

describe('versioned recipient profile review',()=>{
 it('keeps historical profiles fixed and exposes only effective reviewed versions',()=>{
  const historical=recipientProfile('ebay-payment-dispute-us-v1',new Date('2026-09-20'));
  const frozen=JSON.stringify(historical);
  expect(historical).toMatchObject({version:'2026-09-07.1',checkedAt:'2026-09-07',reviewAfter:'2026-10-07'});
  expect(()=>recipientProfile(historical.id,new Date('2026-10-22'))).toThrowError(/current review/);
  const current=recipientProfile('ebay-payment-dispute-us-v2',new Date('2026-10-22'));
  expect(current).toMatchObject({version:'2026-10-22.1',checkedAt:'2026-10-22',reviewAfter:'2026-11-21'});
  expect(JSON.stringify(historical)).toBe(frozen);
  for(const at of ['2026-10-21T23:59:59.999Z','2026-11-21T00:00:00.000Z']){
   expect(()=>recipientProfile(current.id,new Date(at))).toThrow();
   expect(listRecipientProfiles({now:()=>new Date(at)}).profiles.find(p=>p.id===current.id)?.reviewRequired).toBe(true);
  }
  const available=listRecipientProfiles({now:()=>new Date('2026-10-22')}).profiles.filter(p=>!p.reviewRequired);
  expect(available.map(p=>p.id)).toEqual(['ebay-payment-dispute-us-v2','stripe-dispute-us-mastercard-v2','stripe-dispute-us-other-v2']);
  expect(new Set(RECIPIENT_PROFILES.map(p=>p.id)).size).toBe(RECIPIENT_PROFILES.length);
 });
 it('enforces the reviewed strict eBay byte limit and Stripe page/byte budgets',()=>{
  const image=(size:number,pages=1)=>{const bytes=Buffer.alloc(size);bytes[0]=255;bytes[1]=216;bytes[size-2]=255;bytes[size-1]=217;return {name:'review.jpg',contentType:'image/jpeg',bytes,pages,width:1500,height:2000};};
  const ebay=recipientProfile('ebay-payment-dispute-us-v2',new Date('2026-10-22'));
  expect(validateRecipientFiles(ebay,[image(1749999)]).bytes).toBe(1749999);
  expect(()=>validateRecipientFiles(ebay,[image(1750000)])).toThrow();
  expect(()=>validateRecipientFiles(ebay,Array.from({length:6},()=>image(100)))).toThrow();
  const stripe=recipientProfile('stripe-dispute-us-mastercard-v2',new Date('2026-10-22'));
  expect(validateRecipientFiles(stripe,[image(4500000,19)]).pages).toBe(19);
  expect(()=>validateRecipientFiles(stripe,[image(4500001)])).toThrow();
  expect(()=>validateRecipientFiles(stripe,[image(100,20)])).toThrow();
 });
});
