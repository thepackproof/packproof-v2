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
 await screen.findByRole('heading',{name:'We found your shipments.'});
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
