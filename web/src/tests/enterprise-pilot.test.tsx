import { describe,it,expect,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { PackProofApi } from '../api/client';
import { EnterpriseScreen } from '../enterprise/EnterpriseScreen';
afterEach(cleanup);
const site={id:'site-a',organization_id:'merchant-a',name:'Synthetic branch A',mode:'SYNTHETIC',role:'REVIEWER'};
const search={items:[{id:'dossier-a',externalId:'SYNTH-VARIANCE',exceptionCount:2,fulfillments:['SHIP-A'],synthetic:true}],nextCursor:null};
const dossier={id:'dossier-a',externalId:'SYNTH-VARIANCE',synthetic:true,site:{id:'site-a',name:'Synthetic branch A',mode:'SYNTHETIC',fulfillmentMode:'LOCAL_DELIVERY'},sourceId:'source-a',fulfillments:['SHIP-A'],notice:'Unknown is not zero. No fault is assigned.',sources:[{id:'source-a',name:'Synthetic export',last_import_at:null,stale:true}],
 reconciliation:{lines:[{id:'line-a',externalId:'1',itemIds:['VALVE'],effectiveOrdered:{quantity:'10',uom:'EA',recordIds:['record-a'],coverage:'PRESENT'},stages:{PICKED:{quantity:'10',uom:'EA',recordIds:['record-a'],coverage:'PRESENT'},LOADED:{quantity:'8',uom:'EA',recordIds:['record-a'],coverage:'PRESENT'}}}],exceptions:[{key:'exception-a',code:'LOAD_QTY_DIFFERS_FROM_PICK',lineId:'line-a',recordIds:['record-a'],message:'Picked 10 EA; loaded 8 EA.',logic:'No fault is inferred.'}]},
 timeline:[{id:'record-a',recordKey:'load-row-1',revision:'1',sourceName:'Synthetic export',sourceId:'source-a',importId:'batch-a',stage:'LOADED',fulfillmentId:'SHIP-A',occurredAtLocal:null,sourceTimezone:null,occurredAtUtc:null,timeConfidence:'UNKNOWN',ingestedAt:'2026-10-26T12:00:00Z',association:'SOURCE_IDENTIFIER',provenance:'SOURCE_ASSERTED',evidence:[],warnings:[]}],evidence:[],annotations:[]};
function client(){
 const fn=vi.fn(async(path:string,method='GET',body?:unknown)=>{
  if(path==='/sites')return {sites:[site]};
  if(path.startsWith('/dossiers?'))return search;
  if(path==='/dossiers/dossier-a')return dossier;
  if(path==='/dossiers/dossier-a/records/record-a')return {raw_payload:{quantity:'8',uom:'EA'},normalized:{stage:'LOADED'}};
  if(path==='/dossiers/dossier-a/annotations'&&method==='POST')return {id:'note-a',body};
  throw Error('Unexpected test request '+path);
 });
 return {api:{enterpriseRequest:fn} as unknown as PackProofApi,fn};
}
describe('enterprise reviewer workspace',()=>{
 it('shows synthetic scope, unknown quantities, discrepancy sources and append-only review',async()=>{
  const {api,fn}=client();render(<EnterpriseScreen api={api} onBack={()=>{}}/>);
  await screen.findByText('SYNTHETIC · No Winsupply data');
  fireEvent.click(await screen.findByRole('button',{name:/SYNTH-VARIANCE/}));
  await screen.findByRole('heading',{name:'Quantity reconciliation'});expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);expect(screen.getByText('Picked 10 EA; loaded 8 EA.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Inspect source record'}));await screen.findByRole('heading',{name:'Original fields & normalized assertions'});
  expect(screen.getByText(/"quantity": "8"/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Reason'),{target:{value:'Confirmed partial delivery in source ticket.'}});fireEvent.click(screen.getByRole('button',{name:'Append reviewer note'}));
  await waitFor(()=>expect(fn).toHaveBeenCalledWith('/dossiers/dossier-a/annotations','POST',expect.objectContaining({reason:'Confirmed partial delivery in source ticket.'}),expect.any(String)));
 });
 it('presents disabled access safely without showing a record',async()=>{
  const api={enterpriseRequest:vi.fn().mockRejectedValue(new Error('Enterprise pilot access has not been enabled'))} as unknown as PackProofApi;
  render(<EnterpriseScreen api={api} onBack={()=>{}}/>);expect(await screen.findByRole('alert')).toHaveTextContent('Enterprise pilot access has not been enabled');expect(screen.queryByRole('heading',{name:'Quantity reconciliation'})).toBeNull();
 });
});
