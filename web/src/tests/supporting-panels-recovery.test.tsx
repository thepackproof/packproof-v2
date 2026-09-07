import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { EvidenceResponsePanel } from '../components/EvidenceResponsePanel';
import { PackingRequestsPanel } from '../components/PackingRequestsPanel';
import { UsagePanel } from '../components/UsagePanel';
const scope='https://api.example.test';
const asApi=(value:object)=>value as PackProofApi;
const supplement=(body:{operationId:string;kind:string;facts:unknown},actor='seller')=>({supplementId:'supplement-1',proofId:'proof-1',sequence:1,kind:body.kind,createdAt:'2026-09-07T00:00:00Z',canonicalJson:JSON.stringify({proofId:'proof-1',operationId:body.operationId,kind:body.kind,actorUserId:actor,facts:body.facts})});
function expand(text:string){const summary=screen.getByText(text);const details=summary.closest('details')!;details.open=true;fireEvent(details,new Event('toggle'));}
beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('account-scoped supplemental statement recovery',()=>{
  it('retries the exact saved intent after a lost response and reload',async()=>{
    const mutations:Record<string,unknown>[]=[];
    const api={recoveryScope:scope,featureRequest:vi.fn(async(_proof:string,_path:string,method?:string,body?:Record<string,unknown>)=>{if(method!=='POST')return {supplements:[]};mutations.push(body!);if(mutations.length===1)throw new Error('Response lost');return supplement(body as never);})};
    const first=render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'The seal was intact.'}});fireEvent.click(screen.getByRole('button',{name:'Add statement to Proof'}));await screen.findByText('Response lost');first.unmount();
    render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');
    expect(screen.getByRole('textbox')).toHaveValue('The seal was intact.');expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button',{name:'Retry saved statement'}));await screen.findByText('Statement recorded. Preservation confirmation may still be pending.');
    expect(mutations).toHaveLength(2);expect(mutations[1]).toEqual(mutations[0]);expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('recognizes an already accepted operation on reload without resubmission',async()=>{
    let accepted:unknown=null;
    const api={recoveryScope:scope,featureRequest:vi.fn(async(_proof:string,_path:string,method?:string,body?:Record<string,unknown>)=>{if(method!=='POST')return {supplements:accepted?[accepted]:[]};accepted=supplement(body as never);throw new Error('Response lost');})};
    const first=render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Recorded context'}});fireEvent.click(screen.getByRole('button',{name:'Add statement to Proof'}));await screen.findByText('Response lost');first.unmount();
    render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');await screen.findByText('Statement recorded. Preservation confirmation may still be pending.');
    expect(api.featureRequest.mock.calls.filter(call=>call[2]==='POST')).toHaveLength(1);expect(screen.getByRole('textbox')).toHaveValue('');
  });
  it('hides drafts on account/API changes and recovers them only in their original scope',async()=>{
    const api={recoveryScope:scope,featureRequest:vi.fn().mockResolvedValue({supplements:[]})};
    const view=render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');fireEvent.change(screen.getByRole('textbox'),{target:{value:'Private seller draft'}});
    view.rerender(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="buyer" role="BUYER"/>);expand('Responses and corrections');expect(screen.getByRole('textbox')).toHaveValue('');
    view.rerender(<EvidenceResponsePanel api={asApi({...api,recoveryScope:'https://other.example.test'})} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');expect(screen.getByRole('textbox')).toHaveValue('');
    view.rerender(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');expect(screen.getByRole('textbox')).toHaveValue('Private seller draft');
  });
  it('renders null source facts safely and stops posting when local recovery storage fails',async()=>{
    const api={recoveryScope:scope,featureRequest:vi.fn().mockResolvedValue({supplements:[supplement({operationId:'existing-operation',kind:'CORRECTION',facts:null})]})};
    render(<EvidenceResponsePanel api={asApi(api)} proofId="proof-1" userId="seller" role="SELLER"/>);expand('Responses and corrections');await screen.findByText('Source facts are available in the integrity record.');
    vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('Quota');});fireEvent.change(screen.getByRole('textbox'),{target:{value:'Keep my statement'}});
    expect(screen.getByRole('textbox')).toHaveValue('Keep my statement');expect(screen.getByRole('button',{name:'Add statement to Proof'})).toBeDisabled();expect(api.featureRequest.mock.calls.filter(call=>call[2]==='POST')).toHaveLength(0);
  });
});
describe('account-scoped supporting panels',()=>{
  it('removes previous-account requests immediately and rejects malformed rows',async()=>{
    const row={requestId:'r1',buyerUserId:'buyer',sellerUserId:'seller',orderReference:'Private order',state:'REQUESTED',proofId:null,expiresAt:'2026-09-08T00:00:00Z',statusText:'Not provided',cost:'No charge'};
    const api={recoveryScope:scope,packingRequest:vi.fn().mockResolvedValueOnce({requests:[row]}).mockResolvedValue({requests:[{...row,state:null}]})};
    const view=render(<PackingRequestsPanel api={asApi(api)} userId="seller" proofs={[]} onOpen={()=>{}}/>);expand('Request a packing Proof');await screen.findByText('Private order');
    view.rerender(<PackingRequestsPanel api={asApi(api)} userId="unrelated" proofs={[]} onOpen={()=>{}}/>);expect(screen.queryByText('Private order')).not.toBeInTheDocument();expand('Request a packing Proof');await screen.findByText('Packing requests are temporarily unavailable.');
  });
  it('does not display stale usage after account switch and fails closed on malformed offers',async()=>{
    const usage={window:{start:'2026-09-01',end:'2026-10-01'},message:'Seller private usage',finalizedWithDurabilityReceipt:2,finalizedWithoutConfirmedDurability:1,recordedUsageUnits:2,currentOffer:null};
    let resolveOld!:(value:unknown)=>void;
    const api={recoveryScope:scope,getUsage:vi.fn().mockResolvedValueOnce(usage).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValueOnce({...usage,currentOffer:{period:null}})};
    const view=render(<UsagePanel api={asApi(api)} userId="seller"/>);await screen.findByText('Seller private usage');
    view.rerender(<UsagePanel api={asApi(api)} userId="buyer"/>);expect(screen.queryByText('Seller private usage')).not.toBeInTheDocument();await waitFor(()=>expect(resolveOld).toBeTypeOf('function'));
    view.rerender(<UsagePanel api={asApi(api)} userId="another"/>);await screen.findByText('Usage is temporarily unavailable.');
    await act(async()=>resolveOld({...usage,message:'Late buyer usage'}));expect(screen.queryByText('Late buyer usage')).not.toBeInTheDocument();
  });
});
