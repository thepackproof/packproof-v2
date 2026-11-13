// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {ConnectApp} from './ConnectApp';
import type {ConnectBridge,ConnectStatus,Configuration} from './types';
afterEach(cleanup);
const config:Configuration={sourceName:'Scheduled CSV Export Folder v1',folderDigest:'f'.repeat(64),integrationAccountId:'source-test',operatorMembershipId:'member-test',locationId:null,timeZone:'America/New_York',importValidRows:false,offlineWindowHours:24,mapping:{shipmentReference:'Shipment reference',itemTitle:'Description',quantity:'Quantity',shippedAt:'Shipment date'},sourceContract:{schema:'packproof.scheduled-csv/v1',exporterName:'PackProof test CSV',exporterVersion:'1.0',expectedHeaders:['Shipment reference','Description','Quantity','Shipment date'],expectedIntervalSeconds:900,backfillFrom:'2026-11-13T00:00:00-05:00'}};
const selected:ConnectStatus={state:'source_selected',environment:'development',installationId:'install-current',configRevision:0,binding:{sourceName:config.sourceName,integrationAccountId:'source-test',operatorMembershipId:'member-test',locationId:null},enrollment:{id:'redeemed-enrollment',comparisonCode:'OLD-CODE',state:'credential',expiresAt:'2026-11-12T00:00:00Z'},source:{folder:'prepared export folder',folderDigest:config.folderDigest,accessible:true,selectedFileName:'test.csv',fileSha256:'d'.repeat(64),headers:config.sourceContract!.expectedHeaders,samples:[{'Shipment reference':'PP-TEST-001',Description:'TEST ONLY',Quantity:'1','Shipment date':'2026-11-13T09:00:00-05:00'}]},health:{serviceOnline:true,queueCount:0}};
it('does not offer browser review while the source details are incomplete and no request exists',async()=>{
 const openApproval=vi.fn();render(<ConnectApp bridge={{getStatus:vi.fn(async()=>selected),openApproval} as unknown as ConnectBridge}/>);
 await screen.findByRole('heading',{name:'Get ready'});await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh status'})).toBeEnabled());
 expect(screen.getByRole('button',{name:'Request configuration approval'})).toBeDisabled();
 const review=screen.getByRole('button',{name:'Review in browser'});expect(review).toBeDisabled();fireEvent.click(review);expect(openApproval).not.toHaveBeenCalled();
 expect(screen.getByRole('button',{name:/Continue to secure preview/})).toBeDisabled();
});
it('offers the saved configuration review without granting upload consent or approving the request',async()=>{
 const current={...selected,pendingProposal:config,approvalPath:'/app/records/connect/approve?installationId=install-current'};
 const openApproval=vi.fn(async()=>undefined);render(<ConnectApp bridge={{getStatus:vi.fn(async()=>current),openApproval} as unknown as ConnectBridge}/>);
 await screen.findByRole('heading',{name:'Get ready'});await waitFor(()=>expect(screen.getByRole('button',{name:'Review in browser'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Review in browser'}));expect(openApproval).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('button',{name:/Continue to secure preview/})).toBeDisabled();
 expect(screen.getByRole('checkbox',{name:/including columns that are not mapped/})).not.toBeChecked();
});
