import {describe,expect,it} from 'vitest';
import {validatePublicationReceipt} from '../src/billing/publication-receipt.js';
import type {OfferDefinition} from '../src/billing/usage-ledger.js';
import {syntheticPublication} from './program-metrics-publication-fixture.js';
const at=new Date('2026-09-07T12:00:00Z'),clock={now:()=>new Date(at)};
const offer:OfferDefinition={schemaVersion:'packproof.billing.v1',version:'policy-test-v1',status:'approved',currency:'USD',priceMinor:2900,interval:'monthly',includedFinalizedProofs:100,maxRecordingBytes:250000000,maxRecordingSeconds:300,retentionPolicyVersion:'test-retention-v1',preservationStandard:'canonical-original-v1',supplements:'included_within_published_allowance',overage:'block_new_capture',approvedTermsReference:'synthetic-terms-review'};
describe('approved offer publication receipt',()=>{
 it('accepts only an exact independently pinned current receipt',()=>{const input=syntheticPublication(offer,at);expect(validatePublicationReceipt(offer,clock,input).receiptSha256).toBe(input.trustedReceiptSha256);expect(()=>validatePublicationReceipt(offer,clock,{...input,trustedReceiptSha256:'0'.repeat(64)})).toThrow('pinned');});
 it('refuses a still-fresh pinned receipt from another or unidentified runtime release',()=>{const input=syntheticPublication(offer,at);expect(()=>validatePublicationReceipt(offer,clock,{...input,expectedReleaseSha:'2'.repeat(40)})).toThrow();expect(()=>validatePublicationReceipt(offer,clock,{...input,expectedReleaseSha:''})).toThrow();});
 it('refuses changed offer, terms, receipt and elapsed review even if status says passed',()=>{const input=syntheticPublication(offer,at);expect(()=>validatePublicationReceipt({...offer,priceMinor:7900},clock,input)).toThrow();expect(()=>validatePublicationReceipt({...offer,approvedTermsReference:'different'},clock,input)).toThrow();expect(()=>validatePublicationReceipt(offer,clock,{...input,receipt:{...input.receipt,entitySha256:'0'.repeat(64)}})).toThrow();expect(()=>validatePublicationReceipt(offer,{now:()=>new Date(at.getTime()+86400000)},input)).toThrow();});
});
