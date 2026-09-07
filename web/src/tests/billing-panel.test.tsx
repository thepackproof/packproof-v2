import {act,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {BillingPanel} from '../components/BillingPanel';
import type {PackProofApi} from '../api/client';
const invoice={invoiceReference:'in_fixture',status:'paid',currency:'USD',amountDueMinor:2900,amountPaidMinor:2900,createdAt:'2026-01-01T00:00:00.000Z'};
const page={enabled:true,environment:'sandbox',hasMore:false,nextStartingAfter:null,invoices:[invoice]};
describe('account billing display',()=>{
  it('labels sandbox invoices and hides provider features when billing is disabled',async()=>{
    const api={recoveryScope:'https://api.fixture',getBillingInvoices:vi.fn().mockResolvedValue(page)} as unknown as PackProofApi;
    const rendered=render(<BillingPanel api={api} userId="seller"/>);
    expect(await screen.findByText('in_fixture')).toBeTruthy();
    expect(screen.getByText('Test billing records. These are not live charges.')).toBeTruthy();
    const disabled={recoveryScope:'https://disabled.fixture',getBillingInvoices:vi.fn().mockResolvedValue({enabled:false,invoices:[]})} as unknown as PackProofApi;
    rendered.rerender(<BillingPanel api={disabled} userId="seller"/>);
    await waitFor(()=>expect(screen.queryByText('Billing invoices')).toBeNull());
  });
  it('does not show another account\'s delayed invoice response',async()=>{
    let release!:(value:unknown)=>void;
    const old={recoveryScope:'https://api.fixture',getBillingInvoices:vi.fn(()=>new Promise(resolve=>{release=resolve;}))} as unknown as PackProofApi;
    const next={recoveryScope:'https://api.fixture',getBillingInvoices:vi.fn().mockResolvedValue({...page,invoices:[]})} as unknown as PackProofApi;
    const rendered=render(<BillingPanel api={old} userId="seller-a"/>);
    rendered.rerender(<BillingPanel api={next} userId="seller-b"/>);
    await screen.findByText('No invoices are available for this billing account.');
    await act(async()=>release(page));
    expect(screen.queryByText('in_fixture')).toBeNull();
  });
});
