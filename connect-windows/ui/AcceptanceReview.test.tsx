// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {ConnectApp} from './ConnectApp';
import {analysis,bridgeFor,selected} from './test-fixtures';
import type {ConnectStatus,TransportObservation} from './types';

afterEach(cleanup);
const freshProbe=():TransportObservation=>{
 const now=Date.now();return {state:'compatible',attemptedAt:new Date(now-1000).toISOString(),succeededAt:new Date(now-500).toISOString(),expiresAt:new Date(now+119000).toISOString(),expectedRulesVersion:analysis.binding.rulesVersion,observedRulesVersion:analysis.binding.rulesVersion,sourceContracts:['packproof.scheduled-csv/v2']};
};
const current=():ConnectStatus=>({...selected,transport:freshProbe()});

it('explains a report-wide failure even when every required field was recognized',async()=>{
 const status={...current(),analysis:{...analysis,ready:false,issues:['REPEATED_SHIPMENT_REFERENCE: This report has repeated shipment rows. Provide the supported one-shipment-per-row export; line items are not aggregated.']}};
 render(<ConnectApp bridge={bridgeFor(status)}/>);
 await screen.findByRole('heading',{name:'Check the details in this report.'});
 expect(screen.getByText(/This report has repeated shipment rows/)).toBeVisible();
 expect(screen.getByRole('button',{name:'Yes, this looks right'})).toBeDisabled();
 expect(screen.queryByText('✓ Required shipment details recognized')).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Choose a different report'})).toBeEnabled();
});

it('traps drawer keyboard focus and restores its opener after Escape',async()=>{
 const user=userEvent.setup();
 render(<ConnectApp bridge={bridgeFor(current())}/>);
 const opener=await screen.findByRole('button',{name:'View report details'});
 await user.click(opener);
 const drawer=screen.getByRole('dialog');
 const close=within(drawer).getByRole('button',{name:'Close advanced settings'});
 expect(close).toHaveFocus();
 const controls=Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]'));
 const last=controls.at(-1)!;
 fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(last).toHaveFocus();
 fireEvent.keyDown(last,{key:'Tab'});expect(close).toHaveFocus();
 fireEvent.keyDown(close,{key:'Escape'});
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(opener).toHaveFocus();
});

it('keeps local recognition usable and optional fields quiet after an obsolete network error',async()=>{
 const status={...current(),health:{...selected.health,lastErrorCode:'NETWORK_UNAVAILABLE'}};
 render(<ConnectApp bridge={bridgeFor(status)}/>);
 await screen.findByRole('heading',{name:'We found your shipments.'});
 expect(screen.getByRole('button',{name:'Yes, this looks right'})).toBeEnabled();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 for(const field of ['Tracking number','Carrier','Location'])expect(screen.queryByText(field,{exact:true})).not.toBeInTheDocument();
 expect(screen.getByText('2026-11-13T09:00:00-05:00')).toBeVisible();
 expect(screen.getByText('Local preview — nothing uploaded')).toBeVisible();
});

it('clarifies shipment identity in place with exact candidate examples and rechecks every row',async()=>{
 const base=current();
 const ambiguous={...analysis,ready:false, interpretation:{version:'packproof.shipment-interpretation/v1' as const,outcome:'needs_review' as const,grain:'unknown' as const,reasonCodes:['MULTIPLE_CANDIDATES']},
  decisions:analysis.decisions.map(d=>d.field==='shipmentReference'?{...d,state:'missing_required' as const,sourceColumnId:null,candidates:['Dispatch ID','Consignment ID'],examples:{'Dispatch ID':['000123'],'Consignment ID':['ABC-456']}}:d)};
 const bridge=bridgeFor({...base,analysis:ambiguous},{analyzeLocal:async input=>{
  expect(input.mapping.shipmentReference).toBe('Dispatch ID');
  expect(input.confirmedFields).toContain('shipmentReference');
  return base;
 }});
 render(<ConnectApp bridge={bridge}/>);
 const choices=await screen.findByRole('group',{name:'Choices for Shipment number'});
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.getByRole('button',{name:'Yes, this looks right'})).toBeDisabled();
 fireEvent.click(within(choices).getByRole('button',{name:/Dispatch ID.*000123/}));
 await screen.findByRole('heading',{name:'We found your shipments.'});
 expect(screen.getByRole('button',{name:'Yes, this looks right'})).toBeEnabled();
 expect(bridge.previewCloud).not.toHaveBeenCalled();
 expect(bridge.startSetup).not.toHaveBeenCalled();
});

it('routes an order-grain report to source qualification without suggesting a shipment',async()=>{
 const base=current();
 const bridge=bridgeFor({...base,capabilities:{...base.capabilities!,typedSourceSubscriptions:true},
   analysis:{...analysis,ready:false,interpretation:{version:'packproof.shipment-interpretation/v1',outcome:'blocked',grain:'order',reasonCodes:['ORDER_GRAIN']}}});
 render(<ConnectApp bridge={bridge}/>);
 await screen.findByRole('heading',{name:'This report contains order records.'});
 expect(screen.queryByRole('article',{name:'Shipment preview'})).toBeNull();
 expect(screen.getByRole('button',{name:'Yes, this looks right'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Open operational sources'}));
 await screen.findByRole('heading',{name:'Your sources'});
 expect(bridge.startSetup).not.toHaveBeenCalled();
 expect(bridge.proposeSubscription).not.toHaveBeenCalled();
});

it('retains matching native preflight checks through a local file selection and keeps reorder approval explicit',async()=>{
 const report={...current(),checks:undefined,capabilities:{...selected.capabilities!,csvHeaderPolicies:['same_names_any_order/v1']}};
 const cleared={...report,source:undefined,analysis:undefined};
 const bridge=bridgeFor(cleared,{checkComputer:async()=>({...cleared,checks:selected.checks}),chooseFolder:async()=>report,previewLocal:async()=>report});
 render(<ConnectApp bridge={bridge}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Choose shipment folder'}));
 fireEvent.click(await screen.findByRole('button',{name:'Yes, this looks right'}));
 const request=screen.getByRole('button',{name:'Review permissions in browser'});
 expect(request).toBeEnabled();
 fireEvent.click(screen.getByText('Column order in future reports'));
 const permission=screen.getByRole('checkbox',{name:'Allow the same report columns in a different order'});
 expect(permission).not.toBeChecked();
 fireEvent.click(permission);
 fireEvent.click(request);
 expect(bridge.startSetup).toHaveBeenCalledWith({wholeFileUploadApproved:true,draftRevision:1,allowColumnReordering:true});
});

it('requires server admission of a versioned interpretation even when the local shipment is ready',async()=>{
 const base=current();
 const bridge=bridgeFor({...base,analysis:{...analysis,interpretation:{version:'packproof.shipment-interpretation/v1',outcome:'automatic',grain:'shipment',reasonCodes:[]}}});
 render(<ConnectApp bridge={bridge}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Yes, this looks right'}));
 expect(screen.getByText('This check is available locally')).toBeVisible();
 expect(screen.getByRole('button',{name:'Review permissions in browser'})).toBeDisabled();
 expect(bridge.startSetup).not.toHaveBeenCalled();
});

it('collects all ambiguous field meanings before a single full-file recheck',async()=>{
 const base=current();
 const questions={...analysis,ready:false,decisions:analysis.decisions.map(d=>{
  const candidates=d.field==='shipmentReference'?['Dispatch key','Consignment']:
    d.field==='quantity'?['Total units','Pack count']:null;
  return candidates?{...d,state:'needs_confirmation' as const,candidates,sourceColumnId:null}:d;
 })};
 const bridge=bridgeFor({...base,analysis:questions});
 render(<ConnectApp bridge={bridge}/>);
 const ids=within(await screen.findByRole('group',{name:'Choices for Shipment number'}));
 fireEvent.click(ids.getByRole('button',{name:/Dispatch key/}));
 expect(screen.getByRole('button',{name:'Confirm these details and check all rows'})).toBeDisabled();
 expect(bridge.analyzeLocal).not.toHaveBeenCalled();
 const qty=within(screen.getByRole('group',{name:'Choices for Quantity'}));
 fireEvent.click(qty.getByRole('button',{name:/Pack count/}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm these details and check all rows'}));
 expect(bridge.analyzeLocal).toHaveBeenCalledTimes(1);
 expect(bridge.analyzeLocal).toHaveBeenCalledWith({mapping:{...analysis.configuration.mapping, shipmentReference:'Dispatch key',quantity:'Pack count'},confirmedFields:['shipmentReference','quantity']});
 expect(bridge.startSetup).not.toHaveBeenCalled();
});
