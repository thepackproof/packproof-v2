import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientProofDashboard } from '../screens/ClientProofDashboard';
import type { PackProofApi } from '../api/client';
import type { ProofSearchItem, ProofSearchResult } from '../../../backend/src/platform/proof-search';

afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
function row(id:string,state:ProofSearchItem['readiness']['state']='READY'):ProofSearchItem{
 return {proofId:id,transactionId:'transaction-'+id,status:'FINALIZED',createdAt:'2026-10-28T12:00:00Z',updatedAt:'2026-10-28T12:00:00Z',finalizedAt:'2026-10-28T12:00:00Z',
 externalId:'ORDER-'+id,itemTitle:'Synthetic shipment',itemCount:1,trackingNumber:'TRACK-'+id,connectionId:null,provider:null,recordedBy:'operator-'+id,serverReceivedAt:'2026-10-28T12:00:00Z',
 readiness:{state,reason:state==='READY'?null:'PRESERVATION_PENDING',preserved:state==='READY'}};
}
function page(proofs:ProofSearchItem[],nextCursor:string|null=null):ProofSearchResult{return {apiVersion:'v1',schema:'packproof.proof-search/v1',proofs,nextCursor,hasMore:nextCursor!==null,refreshedAt:'2026-10-28T12:00:00Z',cursorExpiresAt:'2026-10-28T13:00:00Z'};}
function api(result:ProofSearchResult){
 const searchProofs=vi.fn().mockResolvedValue(result);
 return {value:{searchProofs,listCommerceConnections:vi.fn().mockResolvedValue({connections:[]})} as unknown as PackProofApi,searchProofs};
}
it('keeps finalized-but-unpreserved records In progress and opens the authoritative detail',async()=>{
 const source=api(page([row('ready'),row('pending','IN_PROGRESS')])),onOpenProof=vi.fn();
 render(<ClientProofDashboard api={source.value} onOpenProof={onOpenProof} onCreate={vi.fn()}/>);
 const table=await screen.findByRole('table');
 const pending=within(table).getByRole('button',{name:'ORDER-pending'}).closest('tr')!;
 expect(within(pending).getByText('In progress')).toBeInTheDocument();
 expect(within(pending).queryByText('Ready')).not.toBeInTheDocument();
 expect(within(pending).getByText('Preservation is in progress.')).toBeInTheDocument();
 fireEvent.click(within(table).getByRole('button',{name:'ORDER-ready'}));
 expect(onOpenProof).toHaveBeenCalledWith('ready');
 expect(screen.getByText(/Last updated/)).toBeInTheDocument();
 expect(screen.getByText('Submitted by / received')).toBeInTheDocument();
});
it('sends server filters and appends deduplicated cursor pages',async()=>{
 const source=api(page([row('a')],'signed-next'));
 source.searchProofs.mockResolvedValueOnce(page([row('a')],'signed-next')).mockResolvedValueOnce(page([row('a'),row('b')]));
 render(<ClientProofDashboard api={source.value} onOpenProof={vi.fn()} onCreate={vi.fn()}/>);
 await screen.findByRole('button',{name:'ORDER-a'});
 fireEvent.click(screen.getByRole('button',{name:'Load more Proofs'}));
 await screen.findByRole('button',{name:'ORDER-b'});
 expect(screen.getAllByRole('button',{name:'ORDER-a'})).toHaveLength(1);
 expect(source.searchProofs).toHaveBeenNthCalledWith(2,expect.objectContaining({after:'signed-next',limit:50}));
 fireEvent.change(screen.getByLabelText('Order, tracking or Proof reference'),{target:{value:'  ORDER-b  '}});
 fireEvent.click(screen.getByRole('button',{name:'Search',exact:true}));
 await waitFor(()=>expect(source.searchProofs).toHaveBeenLastCalledWith(expect.objectContaining({q:'ORDER-b',after:undefined})));
 fireEvent.change(screen.getByLabelText('Status'),{target:{value:'NEEDS_ATTENTION'}});
 await waitFor(()=>expect(source.searchProofs).toHaveBeenLastCalledWith(expect.objectContaining({state:'NEEDS_ATTENTION',q:'ORDER-b'})));
 fireEvent.change(screen.getByLabelText('Created from (UTC)'),{target:{value:'2026-10-01'}});
 await waitFor(()=>expect(source.searchProofs).toHaveBeenLastCalledWith(expect.objectContaining({from:'2026-10-01'})));
});
it('refreshes the visible page and pauses polling while hidden',async()=>{
 vi.useFakeTimers();
 const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
 const source=api(page([]));
 await act(async()=>{render(<ClientProofDashboard api={source.value} onOpenProof={vi.fn()} onCreate={vi.fn()}/>);});
 expect(source.searchProofs).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(source.searchProofs).toHaveBeenCalledTimes(1);
 visibility.mockReturnValue('visible');
 await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
 expect(source.searchProofs).toHaveBeenCalledTimes(2);
 await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
 expect(source.searchProofs).toHaveBeenCalledTimes(3);
});
