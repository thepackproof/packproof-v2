// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {ConnectApp} from './ConnectApp';
import {bridgeFor,selected,configuration,analysis} from './test-fixtures';
import type { ConnectStatus } from './types';
import {WorkspaceApp} from './WorkspaceApp';
afterEach(cleanup);
it('does not offer browser approval when no validated analysis or saved request exists',async()=>{
 const bridge=bridgeFor({...selected,analysis:undefined});render(<ConnectApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Choose a report to review'});expect(screen.queryByRole('button',{name:'Continue review in browser'})).toBeNull();expect(bridge.openApproval).not.toHaveBeenCalled();expect(bridge.startSetup).not.toHaveBeenCalled();
});
it('reopens an exact saved request without fabricating upload consent or committing a batch',async()=>{
 const recent=reportConfiguration(Date.now(),'b'.repeat(64),1);
 const bridge=bridgeFor({...selected,pendingProposal:recent});render(<ConnectApp bridge={bridge}/>);await screen.findByRole('button',{name:'Continue review in browser'});fireEvent.click(screen.getByRole('button',{name:'Continue review in browser'}));expect(bridge.openApproval).toHaveBeenCalledTimes(1);expect(bridge.startSetup).not.toHaveBeenCalled();expect(bridge.previewCloud).not.toHaveBeenCalled();expect(bridge.commitBatch).not.toHaveBeenCalled();
});
function reportConfiguration(at:number, digest:string, revision:number) {
 const contract=configuration.sourceContract!;
 return {...configuration,sourceContract:{...contract,analysisRevision:revision,
   historyPolicy:{...contract.historyPolicy!,initialFileSha256:digest,observedAt:new Date(at).toISOString()}}};
}
const click = async(name:string) => fireEvent.click(await screen.findByRole('button',{name}));
function expiredStatus():ConnectStatus {
 return {...selected,binding:{...selected.binding!,locationId:'test-facility'},
   workspace:{phase:'draft',step:'order',sources:[]},setup:{running:true,phase:'permission_review'},
   pendingProposal:reportConfiguration(Date.now()-31*60_000,analysis.binding.fileSha256,1)};
}
it.each([false,true])('rereads a saved expired report from Logistics and requires new operator consent (changed=%s)',async changed=>{
 let current=expiredStatus();
 const digest=changed?'d'.repeat(64):analysis.binding.fileSha256;
 const fresh=reportConfiguration(Date.now(),digest,2);
 const previewLocal=vi.fn(async()=> current={...current,setup:{running:false},
   source:{...current.source!,fileSha256:digest},analysis:{...analysis,configuration:fresh,
     binding:{...analysis.binding,fileSha256:digest,draftRevision:2},
     shipment:{...analysis.shipment!,quantity:changed?17:12}}});
 const startSetup=vi.fn(async()=>current={...current,pendingProposal:fresh,setup:{running:true,phase:'permission_review'}});
 const bridge=bridgeFor(current,{getStatus:vi.fn(async()=>current),previewLocal,startSetup});
 const view=render(<WorkspaceApp bridge={bridge}/>);
 await click('Review the shipment report');
 expect(screen.queryByRole('button',{name:'Continue review in browser'})).toBeNull();
 await click('Read the selected report again');
 expect(previewLocal).toHaveBeenCalledWith('synthetic.csv');
 expect(startSetup).not.toHaveBeenCalled();
 view.unmount();
 render(<WorkspaceApp bridge={bridge}/>);
 await click('Review the shipment report');
 await click('Yes, this looks right');
 await click('Review permissions in browser');
 expect(startSetup).toHaveBeenCalledWith({wholeFileUploadApproved:true,draftRevision:2});
 expect(await screen.findByRole('button',{name:'Continue review in browser'})).toBeVisible();
 expect(bridge.previewCloud).not.toHaveBeenCalled();
 expect(bridge.commitBatch).not.toHaveBeenCalled();
});
it('reports an unavailable saved file and lets the operator retry without reopening the expired proposal',async()=>{
 const current=expiredStatus();
 const previewLocal=vi.fn().mockRejectedValueOnce(new Error('The selected report is unavailable.')).mockResolvedValue(current);
 const bridge=bridgeFor(current,{previewLocal});
 render(<ConnectApp bridge={bridge}/>);
 await click('Read the selected report again');
 expect(await screen.findByText('The selected report is unavailable.')).toBeVisible();
 await click('Read the selected report again');
 expect(previewLocal).toHaveBeenCalledTimes(2);
 expect(bridge.startSetup).not.toHaveBeenCalled();
 expect(bridge.openApproval).not.toHaveBeenCalled();
});
