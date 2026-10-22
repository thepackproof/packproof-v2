import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {PackProofApi} from '../api/client';
import {ClaimReviewPanel} from '../components/ClaimReviewPanel';

const proofId='proof_merchant',caseId='case_packet',hash='a'.repeat(64);
const local=(value:number)=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const choices={proofId,payments:[{integrationAccountId:'account_one',providerAccountId:'acct_merchant',paymentId:'ch_bound'}],orderLines:[{id:'line_one',title:'Camera',quantity:1}]};
function claim(){return {claimCaseId:'claim_one',snapshotSha256:hash,revision:1,preservation:{status:'PRESERVED'},snapshot:{proofId,claimCaseId:'claim_one',revision:1,provider:'stripe',region:'US',paymentMethod:'CARD',source:'MERCHANT_REPORTED',providerVerification:'UNVERIFIED',apiVersion:'MANUAL_PORTAL',integrationAccountId:'account_one',providerAccountId:'acct_merchant',disputeId:'du_one',paymentId:'ch_bound',orderLineIds:[],reasonCode:'product_not_received',network:'VISA',lifecycleStatus:'needs_response',providerDeadline:new Date(Date.now()+86400000).toISOString(),retrievedAt:new Date(Date.now()-3600000).toISOString(),allowedActions:['RESPOND']}};}
function fixture(cases:unknown[]=[]){
 const featureRequest=vi.fn(async(_proof:string,path:string):Promise<unknown>=>{
  if(path==='claim-cases')return {cases};if(path==='claim-cases/options')return choices;
  if(path==='recipient-exports/profiles')return {profiles:[]};if(path==='claim-cases/claim_one')return claim();throw Error('Unexpected request');
 });
 const claimWrite=vi.fn(async(_proof:string,_case:string|null,_body:unknown,_key:string)=>claim()),featureDownload=vi.fn();
 const api={recoveryScope:'merchant',featureRequest,claimWrite,featureDownload} as unknown as PackProofApi;
 return {api,featureRequest,claimWrite,featureDownload};
}
function mount(api:PackProofApi){return render(<ClaimReviewPanel api={api} userId="reviewer" proofId={proofId} caseId={caseId} sources={[]}/>);}
async function newForm(){
 fireEvent.click(await screen.findByRole('button',{name:'Record a new dispute'}));
 fireEvent.change(screen.getByLabelText('Linked account and payment'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('Dispute reference'),{target:{value:'du_one'}});
 fireEvent.change(screen.getByLabelText('Provider reason'),{target:{value:'product_not_received'}});
 fireEvent.change(screen.getByLabelText('Card network'),{target:{value:'VISA'}});
 fireEvent.change(screen.getByLabelText('Portal status'),{target:{value:'needs_response'}});
 fireEvent.change(screen.getByLabelText('Portal deadline (local time)'),{target:{value:local(Date.now()+86400000)}});
 fireEvent.change(screen.getByLabelText('When you checked the portal (local time)'),{target:{value:local(Date.now()-60000)}});
 fireEvent.click(screen.getByLabelText('The portal currently permits a response.'));
 fireEvent.click(screen.getByLabelText('I checked these details in the named provider account.'));
}
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
describe('merchant case review',()=>{
 it('uses only linked payment choices and retries identical writes with the same key after a lost response',async()=>{
  const f=fixture();f.claimWrite.mockRejectedValueOnce(new Error('Response lost. Retry these same details.'));mount(f.api);await newForm();
  fireEvent.click(screen.getByRole('button',{name:'Save dispute details'}));await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Save dispute details'}));await screen.findByRole('heading',{name:'du_one'});
  expect(f.claimWrite).toHaveBeenCalledTimes(2);expect(f.claimWrite.mock.calls[0]).toEqual(f.claimWrite.mock.calls[1]);
  expect(f.claimWrite.mock.calls[0]).toEqual([proofId,null,expect.objectContaining({integrationAccountId:'account_one',paymentId:'ch_bound',disputeId:'du_one',orderLineIds:[],region:'US',paymentMethod:'CARD',allowedActions:['RESPOND']}),expect.any(String)]);
  expect(screen.getByText(/Payment-only scope/)).toBeInTheDocument();expect(f.featureDownload).not.toHaveBeenCalled();
 });
 it('requires explicit current facts and allows an affected line selection',async()=>{
  const f=fixture();mount(f.api);await newForm();
  fireEvent.click(screen.getByLabelText('Camera (quantity 1)'));
  expect(screen.getByRole('button',{name:'Save dispute details'})).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I checked these details in the named provider account.'));
  fireEvent.click(screen.getByRole('button',{name:'Save dispute details'}));await screen.findByRole('heading',{name:'du_one'});
  expect(f.claimWrite).toHaveBeenCalledWith(proofId,null,expect.objectContaining({orderLineIds:['line_one']}),expect.any(String));
 });
 it('records a later observation with the exact prior digest and frozen identity',async()=>{
  const c=claim(),f=fixture([c]);mount(f.api);await screen.findByRole('option',{name:/du_one/});
  fireEvent.change(screen.getByLabelText('Recorded dispute'),{target:{value:c.claimCaseId}});
  fireEvent.click(screen.getByRole('button',{name:'Record updated portal details'}));
  expect(screen.queryByLabelText('Dispute reference')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Save new observation'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('When you checked the portal (local time)'),{target:{value:local(Date.now()-60000)}});
  fireEvent.change(screen.getByLabelText('Portal status'),{target:{value:'under_review'}});
  fireEvent.click(screen.getByLabelText('The portal currently permits a response.'));
  fireEvent.click(screen.getByLabelText('I checked these details in the named provider account.'));
  fireEvent.click(screen.getByRole('button',{name:'Save new observation'}));await waitFor(()=>expect(f.claimWrite).toHaveBeenCalledTimes(1));
  expect(f.claimWrite).toHaveBeenCalledWith(proofId,c.claimCaseId,expect.objectContaining({expectedSnapshotSha256:hash,lifecycleStatus:'under_review',allowedActions:[]}),expect.any(String));
 });
 it.each(['pending','stale','closed','unknown'] as const)('does not enable file preparation for %s cases',async kind=>{
  const c=claim();if(kind==='pending')c.preservation.status='COMMITTED_PENDING_DURABILITY';if(kind==='stale')c.snapshot.retrievedAt=new Date(Date.now()-2*86400000).toISOString();if(kind==='closed')c.snapshot.allowedActions=[];if(kind==='unknown')c.snapshot.network='UNKNOWN';
  const f=fixture([c]);mount(f.api);await screen.findByRole('option',{name:/du_one/});fireEvent.change(screen.getByLabelText('Recorded dispute'),{target:{value:c.claimCaseId}});
  expect(screen.queryByRole('button',{name:'Prepare exact files'})).not.toBeInTheDocument();expect(screen.getByText(/File preparation requires/)).toBeInTheDocument();
 });
 it('rejects crossed Proof responses and clears revoked case data on reload',async()=>{
  const f=fixture([claim()]);mount(f.api);await screen.findByRole('option',{name:/du_one/});fireEvent.change(screen.getByLabelText('Recorded dispute'),{target:{value:'claim_one'}});
  f.featureRequest.mockRejectedValue(new Error('Case access revoked.'));fireEvent.click(screen.getByRole('button',{name:'Reload cases'}));await screen.findByRole('alert');
  expect(screen.queryByRole('heading',{name:'du_one'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Prepare exact files'})).not.toBeInTheDocument();
  cleanup();const crossed=claim();crossed.snapshot.proofId='another-proof';mount(fixture([crossed]).api);await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Record a new dispute'})).not.toBeInTheDocument();
 });
});
