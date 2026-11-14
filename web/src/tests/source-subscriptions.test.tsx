import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { SourceSubscriptionApproval, SourceSubscriptions } from '../records/SourceSubscriptions';
import { AgentApproval } from '../records/AgentConnections';
import { rememberConnectApprovalReturn, consumeConnectApprovalReturn } from '../auth/connect-approval-return';
import { canonicalWorkspacePath } from '../proof-list-state';
import { recordsRoute } from '../records/model';

const config = { transport: 'local_ntfs', displayName: 'Loading export', sourceProfile: 'operational-observations/v1', mappingVersion: 'loading/3', sourceNamespace: 'site-a-wms', mapping: { reportedLoadedQuantity: 'LoadedQty', shipmentId: 'Shipment' }, constants: {}, wholeFileConsent: true, folderDigest: 'a'.repeat(64), initialFileName: 'loading.csv', initialOriginalSha256: 'b'.repeat(64), expectedHeaders: ['Shipment', 'LoadedQty', 'Customer'], historyFrom: '2026-11-14T00:00:00Z', historyTo: null, maxBytes: 2097152, maxRows: 1000, offlineWindowHours: 24, expectedIntervalSeconds: null, unknownTimePolicy: 'quarantine', completenessPolicy: { kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null } };
const subscription = { id: 'source-a', subscriptionId: 'source-a', configurationRevision: 2, grantRevision: 3, state: 'proposed', installationId: 'computer-a', connectionId: 'wms-a', locationId: 'site-a', operatorMembershipId: 'member-a', config, configurationSha256: 'c'.repeat(64), lastCheckAt: null, sourceAsOf: null, updatedAt: '2026-11-14T01:00:00Z', heartbeat: {} };
const scope = { organizationId: 'org-a', environment: 'live', installationId: 'computer-a', subscriptionId: 'source-a', configurationRevision: '2' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function approval(api: PackProofApi, values: Record<string, string> = {}, canManage = true) { return <SourceSubscriptionApproval api={api} organizationId="org-a" environment="live" params={new URLSearchParams({ ...scope, ...values })} canManage={canManage}/>; }

it('approves only the displayed exact source revision with deliberate whole-file consent', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...subscription, state: 'approved' } : subscription), user = userEvent.setup();
  render(approval({ recordsRequest: request } as unknown as PackProofApi));
  expect(await screen.findByRole('heading', { name: 'Loading export' })).toBeVisible();
  expect(screen.getByText('Quarantine records without a source time')).toBeVisible();
  const approve = screen.getByRole('button', { name: 'Approve this source and first original' });
  expect(approve).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /I approve this exact source configuration/ }));
  await user.click(approve);
  const writes = request.mock.calls as unknown as Array<[string, string, Record<string, unknown>, Record<string, string>]>;
  const call = writes.find(([, method]) => method === 'POST')!;
  expect(call.slice(0, 3)).toEqual(['/source-subscriptions/source-a/actions?organizationId=org-a&environment=live', 'POST', { organizationId: 'org-a', environment: 'live', action: 'approve', configurationRevision: 2, configurationSha256: 'c'.repeat(64), wholeFileConsent: true }]);
  expect(call[3]['Idempotency-Key']).toBeTruthy();
});

it('blocks a source approval locator for another installation or revised configuration', async () => {
  const request = vi.fn(async (_path: string, _method?: string) => subscription);
  render(approval({ recordsRequest: request } as unknown as PackProofApi, { installationId: 'other-computer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('different installation or configuration revision');
  expect(screen.queryByRole('button', { name: 'Approve this source and first original' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revoke source access' })).not.toBeInTheDocument();
  expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
});

it('requires a confirmed first receipt and linked case before recurring consent can activate collection', async () => {
  const firstBatch = { id: 'batch-a', state: 'succeeded', originalSha256: config.initialOriginalSha256, linkedCases: [{ id: 'case-a', reference: '0010482' }], counts: { acceptedLinked: 2, duplicate: 0, rejected: 0 }, eligibleForRecurring: true };
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...subscription, state: 'active' } : { ...subscription, state: 'approved', firstBatch }), user = userEvent.setup();
  render(approval({ recordsRequest: request } as unknown as PackProofApi, { initialBatchId: 'batch-a' }));
  expect(await screen.findByRole('link', { name: 'Inspect case 0010482' })).toHaveAttribute('href', '/app/cases/case-a?organizationId=org-a&environment=live');
  const activate = screen.getByRole('button', { name: 'Approve recurring source collection' });
  expect(activate).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /I reviewed the confirmed first records/ }));
  await user.click(activate);
  const writes = request.mock.calls as unknown as Array<[string, string, Record<string, unknown>, Record<string, string>]>;
  expect(writes.find(([, method]) => method === 'POST')![2]).toEqual({ organizationId: 'org-a', environment: 'live', action: 'activate', configurationRevision: 2, initialBatchId: 'batch-a', recurringConsent: true });
});

it('keeps recurring collection disabled while a supplied receipt has not been confirmed', async () => {
  render(approval({ recordsRequest: vi.fn(async () => ({ ...subscription, state: 'approved' })) } as unknown as PackProofApi, { initialBatchId: 'unconfirmed-batch' }));
  expect(await screen.findByText(/Waiting for PackProof to confirm the first receipt/)).toBeVisible();
  await userEvent.setup().click(screen.getByRole('checkbox', { name: /I reviewed the confirmed first records/ }));
  expect(screen.getByRole('button', { name: 'Approve recurring source collection' })).toBeDisabled();
});

it('reuses the source command identity after a lost response and resets consent after a new revision', async () => {
  let current = subscription, failures = 0;
  const request = vi.fn(async (_path: string, method?: string) => { if (method === 'POST') { if (!failures++) throw new Error('Response interrupted'); return { ...current, state: 'approved' }; } return current; });
  const user = userEvent.setup();
  render(approval({ recordsRequest: request } as unknown as PackProofApi));
  await user.click(await screen.findByRole('checkbox', { name: /I approve this exact source configuration/ }));
  await user.click(screen.getByRole('button', { name: 'Approve this source and first original' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Response interrupted');
  await user.click(screen.getByRole('button', { name: 'Approve this source and first original' }));
  await waitFor(() => expect(request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(2));
  const writes = request.mock.calls as unknown as Array<[string, string, Record<string, unknown>, Record<string, string>]>;
  const commands = writes.filter(([, method]) => method === 'POST');
  expect(commands[0][3]['Idempotency-Key']).toBe(commands[1][3]['Idempotency-Key']);
  current = { ...subscription, configurationRevision: 3 };
  await user.click(screen.getByRole('button', { name: 'Refresh source review' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('different installation or configuration revision');
  expect(screen.queryByRole('checkbox', { name: /I approve this exact source configuration/ })).not.toBeInTheDocument();
});

it('does not fetch source configuration for a non-administrator', () => {
  const request = vi.fn();
  render(approval({ recordsRequest: request } as unknown as PackProofApi, {}, false));
  expect(screen.getByRole('alert')).toHaveTextContent('owner or administrator');
  expect(request).not.toHaveBeenCalled();
});

it('routes the existing desktop approval URL to the source review without fetching legacy installation approval', async () => {
  const request = vi.fn(async (_path: string) => subscription);
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="live" params={new URLSearchParams(scope)} canManage/>);
  expect(await screen.findByRole('heading', { name: 'Review this data source' })).toBeVisible();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toBe('/source-subscriptions/source-a?organizationId=org-a&environment=live');
});

it('returns a signed-out recurring source approval to its exact receipt after authentication', async () => {
  sessionStorage.clear();
  rememberConnectApprovalReturn('/app/records/connect/approve?installationId=computer-a&organizationId=org-a&environment=live&subscriptionId=source-a&configurationRevision=2&initialBatchId=batch-a&redeemSecret=PRIVATE', sessionStorage);
  const restored = consumeConnectApprovalReturn(sessionStorage)!;
  const { params: resumed } = recordsRoute(canonicalWorkspacePath(restored));
  const firstBatch = { id: 'batch-a', state: 'succeeded', originalSha256: config.initialOriginalSha256, linkedCases: [{ id: 'case-a', reference: '0010482' }], counts: { accepted_linked: 1 }, eligibleForRecurring: true };
  const request = vi.fn(async (_path: string) => ({ ...subscription, state: 'approved', firstBatch }));
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="live" params={resumed} canManage/>);
  expect(await screen.findByRole('button', { name: 'Approve recurring source collection' })).toBeDisabled();
  expect(request).toHaveBeenCalledWith('/source-subscriptions/source-a?organizationId=org-a&environment=live&initialBatchId=batch-a');
  expect(screen.queryByRole('heading', { name: 'Review this collection computer' })).not.toBeInTheDocument();
  expect(restored).not.toContain('PRIVATE');
});

it('keeps paginated source reviews separate and never presents a quiet collector as complete source coverage', async () => {
  const request = vi.fn(async () => ({ subscriptions: [subscription], nextCursor: 'source-next' }));
  render(<SourceSubscriptions api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="live" canManage/>);
  expect(await screen.findByText('Unknown — source-owner qualification required')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review Loading export' })).toHaveAttribute('href', '/app/records/connect/approve?organizationId=org-a&environment=live&subscriptionId=source-a&configurationRevision=2&installationId=computer-a');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next source page' }));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('/source-subscriptions?organizationId=org-a&environment=live&cursor=source-next'));
});

it('shows an actual source compatibility block in both its source card and exact review', async () => {
  const blocked = { ...subscription, state: 'active', capabilities: { collectorSupported: false, blockedReason: 'Install the matching collector version before using this source contract.' } };
  const request = vi.fn(async (path: string) => path.startsWith('/source-subscriptions?') ? { subscriptions: [blocked], nextCursor: null } : blocked);
  const api = { recordsRequest: request } as unknown as PackProofApi;
  const { rerender } = render(<SourceSubscriptions api={api} organizationId="org-a" environment="live" canManage/>);
  expect(await screen.findByText('Install the matching collector version before using this source contract.')).toBeVisible();
  rerender(approval(api));
  expect(await screen.findByText('Install the matching collector version before using this source contract.')).toBeVisible();
  expect(screen.getByText('Collection needs attention.')).toBeVisible();
});
