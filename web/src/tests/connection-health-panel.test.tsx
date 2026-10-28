import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionHealthPanel } from '../screens/ConnectionHealthPanel';
import type { PackProofApi } from '../api/client';
import type { CommerceConnectionView } from '../api/types';
import type { ConnectionHealthView } from '../api/connection-health';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const connection=(id:string)=>({connectionId:id,provider:'shopify',providerDisplay:'Shopify',externalAccountReference:id,status:'ACTIVE'} as CommerceConnectionView);
const health:ConnectionHealthView={
 schema:'packproof.connection-health/v1',connectionId:'store-a',provider:'shopify',observedAt:'2026-10-28T12:00:00Z',status:'ACTIVE',
 capabilities:{stableAccountId:'durable-shop',automationAvailable:true,automationUnavailableReason:null,exactOrderReadSupported:true,incrementalListSupported:true,orderReadVerified:true,lastOrderReadAt:'2026-10-28T11:00:00Z',webhookSubscriptionsVerified:false,webhookDeliveryVerified:false,lastWebhookReceivedAt:null},
 automation:{optedIn:true,paused:false},sync:{runStatus:'FAILED',sourceWatermarkAt:'2026-10-28T11:00:00Z',sourceAgeSeconds:3600,stale:true,pageResumePending:true,expiredLease:false,pendingProviderEvents:2,oldestPendingProviderEventAt:'2026-10-28T11:30:00Z'},
 coverage:{basis:'DISCOVERED_SOURCE_RECORDS',discovered:5,eligible:4,excluded:1,eligibleWithoutProof:1,awaitingCapture:1,inProgress:1,finalized:1,otherEligible:0,oldestAwaitingCaptureAt:'2026-10-28T11:00:00Z',reviewOrderCount:1,reviewReasons:[{code:'SHOPIFY_PARTIAL_FULFILLMENT_REVIEW_REQUIRED',count:1}]},
 nextAction:'RETRY_SYNC',
};
it('loads only an expanded owner connection and distinguishes finalized counts from preservation readiness',async()=>{
 const getCommerceConnectionHealth=vi.fn().mockResolvedValue(health),onSync=vi.fn();
 const api={getCommerceConnectionHealth} as unknown as PackProofApi;
 render(<ConnectionHealthPanel api={api} connections={[connection('store-a'),connection('store-b')]} busy={false} onSync={onSync} onAutomation={vi.fn()}/>);
 expect(getCommerceConnectionHealth).not.toHaveBeenCalled();
 const summary=screen.getByText(/Shopify · store-a/),details=summary.closest('details')!;
 await act(async()=>{details.open=true;fireEvent(details,new Event('toggle'));});
 expect(getCommerceConnectionHealth).toHaveBeenCalledExactlyOnceWith('store-a');
 expect(screen.getByText(/5 discovered orders · 4 eligible · 1 excluded/)).toBeInTheDocument();
 expect(screen.getByText(/1 finalized · 1 in progress · 1 awaiting capture/)).toBeInTheDocument();
 expect(screen.getByText(/Finalized counts do not confirm preservation readiness/)).toBeInTheDocument();
 expect(screen.getByText(/1 excluded orders need shipment review/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Retry order check'}));
 expect(onSync).toHaveBeenCalledExactlyOnceWith('store-a');
});
