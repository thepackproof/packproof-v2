import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { AgentApproval } from '../records/AgentConnections';

afterEach(cleanup);

const legacy = 'installationId=agent-a&organizationId=org-a&environment=sandbox';
const proposal = { sourceName: 'CSV export', sourceContract: {
  schema: 'packproof.scheduled-csv/v2', expectedHeaders: ['Order'],
  historyPolicy: { initialFileName: 'orders.csv', observedAt: '2020-01-01T00:00:00Z' },
} };
const installed = { id: 'agent-a', deviceName: 'Warehouse PC', version: '0.7.0', state: 'setup',
  locationId: null, configRevision: 0, pendingProposal: proposal, pendingProposalSha256: 'a'.repeat(64) };

function open(query: string, recordsRequest: (path: string, method?: string) => Promise<unknown>, canManage = true,
  locations: Array<{ id: string; name: string }> | null = [{ id: 'site-a', name: 'Warehouse A' }]) {
  render(<AgentApproval organizationId="org-a" environment="sandbox" params={new URLSearchParams(query)}
    canManage={canManage} api={{ recordsRequest } as unknown as PackProofApi} facilityLocations={locations ?? undefined}/>);
}

it('opens the installed client’s stale CSV link on facility recovery and keeps the file decision accessible separately', async () => {
  const request = vi.fn(async () => installed);
  open(legacy, request);
  await screen.findByRole('heading', { name: 'Reconnect this computer to a facility' });
  expect(screen.queryByRole('button', { name: 'Approve configuration' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disconnect and continue' })).toBeDisabled();
  expect(screen.getByRole('list', { name: 'Available facilities' })).toHaveTextContent('Warehouse A');
  fireEvent.click(screen.getByRole('button', { name: /view the separate file/i }));
  expect(screen.getByRole('button', { name: 'Approve configuration' })).toBeDisabled();
  expect(screen.getByText(/review expired after 30 minutes/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Return to facility connection' }));
  expect(screen.getByRole('button', { name: 'Disconnect and continue' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([[], null] as const)('keeps current service access when available destinations cannot be established (%s)', async locations => {
  const request = vi.fn(async () => installed);
  open(legacy, request, true, locations ? [...locations] : null);
  expect(await screen.findByRole('heading', { name: 'Make your facility available' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Renew your export file review' })).toBeVisible();
  expect(screen.getByText('Request a fresh file review')).toBeVisible();
  expect(screen.getByText(/your current connection is still in place/i)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Disconnect and continue' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /view the separate file/i }));
  expect(screen.getByRole('button', { name: 'Approve configuration' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /revoke installation/i })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it('uses the existing scoped revoke only after consent and returns the user to Windows after acknowledgement', async () => {
  let revoked = false;
  const request = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') revoked = true;
    return revoked ? { ...installed, state: 'revoked', pendingProposal: null } : installed;
  });
  open(legacy, request);
  const button = await screen.findByRole('button', { name: 'Disconnect and continue' });
  fireEvent.click(screen.getByRole('checkbox', { name: /disconnect the current service access for warehouse pc/i }));
  fireEvent.click(button);
  await screen.findByRole('heading', { name: 'Continue in PackProof on Windows' });
  expect(screen.getByText('Preserve work and reconnect')).toBeVisible();
  expect(request).toHaveBeenCalledWith('/agent-installations/agent-a/actions?organizationId=org-a&environment=sandbox', 'POST',
    { organizationId: 'org-a', environment: 'sandbox', action: 'revoke' }, { 'Idempotency-Key': expect.any(String) });
});

it('keeps facility connection primary after a saved file review is renewed, including an unmarked old link', async () => {
  const request = vi.fn(async () => ({ ...installed, pendingProposal: { ...proposal, sourceContract: {
    ...proposal.sourceContract, historyPolicy: { ...proposal.sourceContract.historyPolicy, observedAt: new Date().toISOString() },
  } } }));
  open(legacy, request);
  expect(await screen.findByRole('heading', { name: 'Reconnect this computer to a facility' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Approve configuration' })).not.toBeInTheDocument();
  cleanup();
  open(legacy + '&intent=facility', request);
  expect(await screen.findByRole('heading', { name: 'Reconnect this computer to a facility' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Approve configuration' })).not.toBeInTheDocument();
});

it('offers the guarded first connection without revocation and submits only the explicitly chosen facility',async()=>{
  const current={...installed,configSha256:null,facilityConnection:{canAssign:true,canCreate:false,locations:[{id:'site-a',name:'Warehouse A',guidedSetupAvailable:true}]}};
  let connected=false;
  const request=vi.fn(async (_path:string,method?:string,_body?:unknown,_headers?:unknown)=>{
    if(method==='POST')connected=true;
    return connected?{...current,locationId:'site-a',facilityConnection:undefined,pendingProposal:undefined,pendingProposalSha256:undefined,
      capabilities:{guidedFacilitySetup:true}}:current;
  });
  open(legacy,request);
  await screen.findByRole('heading',{name:'Choose this computer’s facility'});
  const connect=screen.getByRole('button',{name:'Connect this computer'});
  expect(connect).toBeDisabled();
  expect(screen.queryByRole('button',{name:'Disconnect and continue'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('Facility')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Facility'),{target:{value:'site-a'}});
  expect(connect).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(connect);
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/agent-installations/agent-a/actions?organizationId=org-a&environment=sandbox','POST',{
    organizationId:'org-a',environment:'sandbox',action:'connect_facility',configRevision:0,configSha256:null,proposalSha256:'a'.repeat(64),locationId:'site-a',
  },{'Idempotency-Key':expect.any(String)}));
  expect(await screen.findByRole('heading',{name:'This computer is connected'})).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Return to PackProof on Windows');
  expect(screen.queryByRole('button',{name:'Disconnect and continue'})).not.toBeInTheDocument();
});

it('lets an authorized administrator name the first facility and requires a new consent when its name changes',async()=>{
  const current={...installed,configSha256:null,facilityConnection:{canAssign:true,canCreate:true,locations:[]}};
  const request=vi.fn(async (_path:string,_method?:string,_body?:unknown,_headers?:unknown)=>current);
  open(legacy,request,true,[]);
  await screen.findByRole('heading',{name:'Name your facility'});
  const name=screen.getByLabelText('Facility name'),connect=screen.getByRole('button',{name:'Connect this computer'});
  fireEvent.change(name,{target:{value:'Columbus test facility'}});
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(name,{target:{value:'Columbus warehouse'}});
  expect(screen.getByRole('checkbox')).not.toBeChecked();expect(connect).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(connect);
  await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.any(String),'POST',expect.objectContaining({action:'connect_facility',facilityName:'Columbus warehouse'}),expect.any(Object)));
  expect(request.mock.calls.find(([,method])=>method==='POST')?.[2]).not.toHaveProperty('locationId');
});

it('does not offer first-facility creation when the server has not granted it', async () => {
  const request = vi.fn(async () => ({...installed,
    facilityConnection:{canAssign:true,canCreate:false,locations:[]}}));
  open(legacy, request, true, []);
  await screen.findByRole('heading', {name:'Choose this computer’s facility'});
  expect(screen.getByRole('status')).toHaveTextContent('A workspace administrator must create a facility or grant access');
  expect(screen.queryByLabelText('Facility name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name:'Connect this computer'})).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps a fresh saved report inspectable but requires the initial facility before configuration approval', async () => {
  const current = {...installed, pendingProposal:{...proposal, sourceContract:{...proposal.sourceContract,
    historyPolicy:{...proposal.sourceContract.historyPolicy, observedAt:new Date().toISOString()}}},
    facilityConnection:{canAssign:true,canCreate:false,locations:[{id:'site-a',name:'Warehouse A',guidedSetupAvailable:true}]}};
  const request = vi.fn(async () => current);
  open(legacy, request);
  await screen.findByRole('heading', {name:'Choose this computer’s facility'});
  fireEvent.click(screen.getByRole('button', {name:'Review saved report separately'}));
  expect(screen.getByRole('heading', {name:'Review the export file'})).toBeVisible();
  expect(screen.getByText('orders.csv')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Choose this computer’s facility before approving this report');
  expect(screen.queryByRole('button', {name:'Approve configuration'})).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', {name:/Approve this exact configuration/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Choose a facility'}));
  expect(screen.getByRole('heading', {name:'Choose this computer’s facility'})).toBeVisible();
  expect(screen.getByLabelText('Facility')).toHaveValue('');
  expect(request).toHaveBeenCalledTimes(1);
});

it('preserves separate report approval for an already configured legacy installation', async () => {
  const current = {...installed, configRevision:1, config:proposal, configSha256:'b'.repeat(64),
    pendingProposal:{...proposal, sourceContract:{...proposal.sourceContract,
      historyPolicy:{...proposal.sourceContract.historyPolicy, observedAt:new Date().toISOString()}}}};
  const request = vi.fn(async () => current);
  open(legacy, request);
  await screen.findByRole('heading', {name:'Reconnect this computer to a facility'});
  fireEvent.click(screen.getByRole('button', {name:/view the separate file/i}));
  const approve = screen.getByRole('button', {name:'Approve configuration'});
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', {name:/Approve this exact configuration/}));
  expect(approve).toBeEnabled();
  expect(screen.getByRole('button', {name:'Return to facility connection'})).toBeVisible();
});

it.each([false, undefined])('keeps a newly named facility waiting for exact setup activation (%s), then continues only after a fresh confirmation', async initialCapability => {
  const current = {...installed, configSha256:null, facilityConnection:{canAssign:true,canCreate:true,locations:[]}};
  let connected = false, guidedFacilitySetup = initialCapability;
  const request = vi.fn(async (_path:string, method?:string, _body?:unknown, _headers?:unknown) => {
    if (method === 'POST') connected = true;
    return connected ? {...current, locationId:'site-new', facilityConnection:undefined, pendingProposal:undefined,
      pendingProposalSha256:undefined, capabilities:{guidedFacilitySetup}} : current;
  });
  open(legacy, request, true, []);
  await screen.findByRole('heading', {name:'Name your facility'});
  fireEvent.change(screen.getByLabelText('Facility name'), {target:{value:'Columbus warehouse'}});
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', {name:'Connect this computer'}));
  expect(await screen.findByRole('heading', {name:'Setup activation is pending'})).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent(initialCapability === false
    ? 'guided setup is not enabled' : 'guided setup availability has not been confirmed');
  expect(screen.queryByText(/Return to PackProof on Windows/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name:'Disconnect and continue'})).not.toBeInTheDocument();
  expect(screen.getByRole('link', {name:'Contact PackProof support'})).toHaveAttribute('href',
    'mailto:admin@thepackproof.com?subject=PackProof%20facility%20setup%20activation');
  guidedFacilitySetup = true;
  fireEvent.click(screen.getByRole('button', {name:'Check setup status'}));
  expect(await screen.findByRole('heading', {name:'This computer is connected'})).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Return to PackProof on Windows');
  expect(request.mock.calls.filter(([,method]) => method === 'POST')).toHaveLength(1);
});

it('keeps an assigned facility in activation recovery when the review is reopened before setup is enabled', async () => {
  const request = vi.fn(async () => ({...installed, locationId:'site-a', pendingProposal:undefined,
    capabilities:{guidedFacilitySetup:false}}));
  open(legacy + '&intent=facility', request);
  expect(await screen.findByRole('heading', {name:'Setup activation is pending'})).toBeVisible();
  expect(screen.getByRole('button', {name:'Check setup status'})).toBeEnabled();
  expect(screen.queryByText(/Return to PackProof on Windows/)).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it('requires an authorized facility for new facility enrollment and never selects one automatically', async () => {
  const request = vi.fn(async () => ({ id: 'enroll-a', deviceName: 'Warehouse PC', version: '0.7.0', state: 'pending',
    expiresAt: new Date(Date.now() + 600000).toISOString(), comparisonCode: 'ABC-123',
    choices: { operators: [{ id: 'member-a', name: 'Operator', role: 'ADMIN' }], integrationAccounts: [{ id: 'source-a', name: 'File source' }], locations: [{ id: 'site-a', name: 'Warehouse A' }] } }));
  open('enrollmentId=enroll-a&intent=facility', request);
  const button = await screen.findByRole('button', { name: 'Approve facility connection' });
  expect(screen.getByLabelText('Approved location')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Code shown in the application'), { target: { value: 'ABC-123' } });
  fireEvent.change(screen.getByLabelText('Authorized source'), { target: { value: 'source-a' } });
  fireEvent.change(screen.getByLabelText('Responsible teammate'), { target: { value: 'member-a' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approved location'), { target: { value: 'site-a' } });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-enrollments/enroll-a/decision?organizationId=org-a&environment=sandbox',
    'POST', expect.objectContaining({ decision: 'approve', comparisonCode: 'ABC-123', locationId: 'site-a' }), expect.any(Object)));
});

it.each([[legacy, false], ['installationId=agent-a&organizationId=other&environment=sandbox&intent=facility', true]] as const)(
  'preserves the authorization boundary for %s', async (query, authorized) => {
    const request = vi.fn(async () => installed);
    open(query, request, authorized);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Disconnect and continue' })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
