import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { SourceBackfills, type SourceBackfill } from '../records/SourceBackfills';
import { SourceSubscriptionApproval, type SourceSubscription } from '../records/SourceSubscriptions';
import { rememberConnectApprovalReturn, consumeConnectApprovalReturn } from '../auth/connect-approval-return';

const source: SourceSubscription = {
  id: 'source-a', subscriptionId: 'source-a', installationId: 'computer-a', connectionId: 'wms-a', locationId: 'site-a', operatorMembershipId: 'member-a',
  configurationRevision: 2, grantRevision: 3, configurationSha256: 'c'.repeat(64), state: 'active',
  lastCheckAt: null, sourceAsOf: null, updatedAt: '2026-11-14T01:00:00Z', heartbeat: {}, capabilities: { sourceBackfillJobs: true },
  config: { transport: 'local_ntfs', displayName: 'Loading export', sourceProfile: 'packproof.operational-observations/v1',
    batchSchema: 'packproof.typed-source-batch/v2', identityPolicy: { schema: 'packproof.source-identity-policy/v1', eventKey: { kind: 'column' }, revision: { kind: 'source_as_of' } },
    mappingVersion: 'loading/3', sourceNamespace: 'site-a-wms', mapping: { sourceEventId: 'ID', sourceAsOf: 'AsOf', shipmentId: 'Shipment', amount: 'LoadedQty', unit: 'Unit' },
    constants: { observationKind: 'snapshot', property: 'reportedLoadedQuantity', timeQuality: 'snapshot_time_only' },
    wholeFileConsent: true, folderDigest: 'a'.repeat(64), initialFileName: 'loading.csv', initialOriginalSha256: 'b'.repeat(64),
    expectedHeaders: ['ID', 'AsOf', 'Shipment', 'LoadedQty', 'Unit'], historyFrom: '2026-10-01T00:00:00Z', historyTo: null,
    maxBytes: 2097152, maxRows: 1000, offlineWindowHours: 24, expectedIntervalSeconds: null, unknownTimePolicy: 'quarantine',
    completenessPolicy: { kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null } },
};
const job: SourceBackfill = {
  schema: 'packproof.source-backfill/v1', id: 'backfill-a', organizationId: 'org-a', environment: 'live', principalId: 'principal-a',
  connectionId: source.connectionId, locationId: source.locationId, operatorMembershipId: source.operatorMembershipId, subscriptionId: source.id, installationId: source.installationId,
  configurationRevision: 2, configurationSha256: source.configurationSha256, grantRevision: 3, credentialId: 'credential-a', manifestSha256: 'd'.repeat(64),
  historyFrom: '2026-10-01T00:00:00Z', historyTo: '2026-10-31T23:59:59Z', semantics: 'cumulative_snapshot', state: 'proposed',
  approvalExpiresAt: null, createdAt: '2026-11-14T01:00:00Z', approvalPath: '', decisions: [], blockReason: null,
  latestDecisionId: null, decisionLimit: 100, decisionsComplete: true,
  originals: [{ id: 'original-a', name: 'loading-october.csv', mediaType: 'text/csv', sha256: 'e'.repeat(64), byteSize: 120,
    batchId: null, receiptState: null, counts: null }],
  progress: { files: { total: 1, received: 0, pending: 1, processing: 0, succeeded: 0, failed: 0 },
    rows: { processing: 0, acceptedLinked: 0, acceptedUnlinked: 0, duplicate: 0, conflict: 0, quarantined: 0, rejected: 0 }, receivedRows: 0 },
  capabilities: { approve: true, pause: false, resume: false, collect: false },
};
const decision: SourceBackfill['decisions'][number] = { id: 'decision-a', action: 'approve', wholeFileConsent: true,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), reason: 'Approved exact historical originals', actorUserId: 'admin-a',
  actorMembershipId: 'admin-member-a', createdAt: '2026-11-14T01:01:00Z', supersedesId: null };
const scope = 'organizationId=org-a&environment=live';
const locator = `/app/records/connect/approve?installationId=computer-a&organizationId=org-a&environment=live&subscriptionId=source-a&configurationRevision=2&backfillJobId=backfill-a&manifestSha256=${job.manifestSha256}`;
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
function api(request: ReturnType<typeof vi.fn>) { return { recordsRequest: request } as unknown as PackProofApi; }
function panel(request: ReturnType<typeof vi.fn>, overrides: Partial<Parameters<typeof SourceBackfills>[0]> = {}) {
  return <SourceBackfills api={api(request)} source={source} organizationId="org-a" environment="live" requestedJobId={job.id} requestedManifest={job.manifestSha256} {...overrides}/>;
}
function reads(current = job) { return vi.fn(async (path: string, _method?: string, _body?: unknown, _headers?: unknown): Promise<unknown> => path.includes('/source-backfills/') ? current : { schema: 'packproof.source-backfills/v1', jobs: [current], nextCursor: null }); }
function futureLocal(hours = 1) {
  const at = new Date(Date.now() + hours * 3600000);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
async function fillApproval(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'Reason for this historical import decision' }), 'Approved October loading history');
  const expires = futureLocal();
  fireEvent.change(screen.getByLabelText('Historical import approval expires (your timezone)'), { target: { value: expires } });
  await user.click(screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ }));
  return new Date(expires).toISOString();
}

it('restores the exact historical manifest after signed-out approval and keeps its consent separate', async () => {
  rememberConnectApprovalReturn(locator + '&token=PRIVATE', sessionStorage);
  const restored = consumeConnectApprovalReturn(sessionStorage)!;
  const request = vi.fn(async (path: string): Promise<unknown> => path.includes('/backfills?') ? { jobs: [job], nextCursor: null } : path.includes('/source-backfills/') ? job : source);
  render(<SourceSubscriptionApproval api={api(request)} organizationId="org-a" environment="live" params={new URL(restored, 'https://packproof.local').searchParams} canManage/>);
  expect(await screen.findByRole('heading', { name: 'Waiting for historical import approval' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Approve exact historical import' })).toBeDisabled();
  expect(restored).toBe(locator);
  expect(restored).not.toContain('PRIVATE');
  expect(request).toHaveBeenCalledWith(`/source-backfills/backfill-a?${scope}`);
  expect(screen.queryByRole('button', { name: 'Approve this source and first original' })).not.toBeInTheDocument();
});

it('submits only the reviewed manifest with independent whole-original consent and an explicit bounded expiry', async () => {
  const request = reads(), user = userEvent.setup();
  render(panel(request));
  const button = await screen.findByRole('button', { name: 'Approve exact historical import' });
  expect(button).toBeDisabled();
  const expiry = await fillApproval(user);
  await user.click(button);
  const writes = request.mock.calls.filter(call => call[1] === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0].slice(0, 3)).toEqual([`/source-backfills/backfill-a/actions?${scope}`, 'POST', {
    organizationId: 'org-a', environment: 'live', action: 'approve', manifestSha256: job.manifestSha256,
    configurationRevision: 2, grantRevision: 3, expectedDecisionId: null, reason: 'Approved October loading history', expiresAt: expiry, wholeFileConsent: true,
  }]);
  expect((writes[0][3] as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  expect(request.mock.calls.some(call => /source-subscriptions\/[^/]+\/actions/.test(call[0]))).toBe(false);
});

it('keeps historical decision retries on the same command identity after a lost response', async () => {
  let failures = 0;
  const request = vi.fn(async (path: string, method?: string, _body?: unknown, _headers?: unknown): Promise<unknown> => {
    if (method === 'POST' && !failures++) throw new Error('Response interrupted');
    return path.includes('/source-backfills/') ? job : { jobs: [job], nextCursor: null };
  });
  const user = userEvent.setup(); render(panel(request));
  await screen.findByRole('button', { name: 'Approve exact historical import' });
  await fillApproval(user);
  await user.click(screen.getByRole('button', { name: 'Approve exact historical import' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Response interrupted');
  await user.click(screen.getByRole('button', { name: 'Approve exact historical import' }));
  const writes = request.mock.calls.filter(call => call[1] === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0][3]).toEqual(writes[1][3]);
});

it('supports the exact historical decision with labeled keyboard controls', async () => {
  const request = reads(), user = userEvent.setup(); render(panel(request));
  const button = await screen.findByRole('button', { name: 'Approve exact historical import' });
  await user.type(screen.getByRole('textbox', { name: 'Reason for this historical import decision' }), 'Reviewed from keyboard');
  fireEvent.change(screen.getByLabelText('Historical import approval expires (your timezone)'), { target: { value: futureLocal() } });
  const consent = screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ });
  consent.focus(); await user.keyboard('[Space]');
  expect(consent).toBeChecked();
  button.focus(); await user.keyboard('{Enter}');
  expect(request.mock.calls.find(call => call[1] === 'POST')?.[2]).toMatchObject({ reason: 'Reviewed from keyboard', wholeFileConsent: true });
});

it.each([
  { label: 'manifest', source, requestedManifest: 'f'.repeat(64) },
  { label: 'grant revision', source: { ...source, grantRevision: 4 }, requestedManifest: job.manifestSha256 },
  { label: 'configuration digest', source: { ...source, configurationSha256: 'f'.repeat(64) }, requestedManifest: job.manifestSha256 },
])('blocks a stale $label without assigning old queued work to new authority', async ({ source: current, requestedManifest }) => {
  const request = reads(); render(panel(request, { source: current, requestedManifest }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer matches the exact source, grant, installation or manifest');
  expect(screen.queryByRole('button', { name: 'Approve exact historical import' })).not.toBeInTheDocument();
  expect(request.mock.calls.every(call => call[1] !== 'POST')).toBe(true);
});

it('disables cached decisions when a fresh exact job read is denied', async () => {
  let denied = false;
  const request = vi.fn(async (path: string, _method?: string): Promise<unknown> => {
    if (denied && path.includes('/source-backfills/')) throw new Error('Current source permission required');
    return path.includes('/source-backfills/') ? job : { jobs: [job], nextCursor: null };
  });
  const user = userEvent.setup(); render(panel(request));
  await screen.findByRole('button', { name: 'Approve exact historical import' });
  denied = true; await user.click(screen.getByRole('button', { name: 'Refresh historical imports' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Current source permission required');
  expect(screen.queryByRole('button', { name: 'Approve exact historical import' })).not.toBeInTheDocument();
});

it('keeps revoked sources and server-blocked jobs read-only', async () => {
  const current = { ...job, capabilities: { approve: false, pause: false, resume: false, collect: false }, blockReason: 'Source authority changed; historical originals remain preserved.' };
  render(panel(reads(current), { source: { ...source, state: 'revoked' } }));
  expect(await screen.findByText(/Historical collection is blocked while this source is/)).toBeVisible();
  expect(screen.getByText(current.blockReason)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Approve exact historical import' })).not.toBeInTheDocument();
});

it('withholds a misrouted workspace manifest instead of presenting it as the requested source', async () => {
  render(panel(reads({ ...job, organizationId: 'other-workspace' })));
  expect(await screen.findByText(/manifest does not match the exact job and workspace/)).toBeVisible();
  expect(screen.queryByText('Files awaiting your decision')).not.toBeInTheDocument();
  expect(screen.queryByText(/loading-october.csv/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve exact historical import' })).not.toBeInTheDocument();
});

it('separates terminal file reconciliation from exclusive row outcomes, including failures and unresolved links', async () => {
  const current: SourceBackfill = { ...job, state: 'completed', decisions: [decision], latestDecisionId: decision.id, capabilities: { approve: false, pause: false, resume: false, collect: false },
    originals: [{ ...job.originals[0], batchId: 'batch-a', receiptState: 'partially_succeeded' }],
    progress: { files: { total: 1, received: 1, pending: 0, processing: 0, succeeded: 0, failed: 1 }, receivedRows: 12,
      rows: { processing: 0, acceptedLinked: 5, acceptedUnlinked: 2, duplicate: 1, conflict: 1, quarantined: 1, rejected: 2 } } };
  render(panel(reads(current)));
  expect(await screen.findByRole('heading', { name: 'Historical processing finished' })).toBeVisible();
  expect(screen.getByText(/Review 1 file and 6 rows requiring attention/)).toBeVisible();
  const review = screen.getByRole('article', { name: 'Historical import review' });
  expect(within(review).getByText('Files requiring attention').nextElementSibling).toHaveTextContent('1');
  expect(screen.getByText('Accepted, awaiting a link').nextElementSibling).toHaveTextContent('2');
  expect(screen.getByText('Conflicts').nextElementSibling).toHaveTextContent('1');
  expect(screen.queryByText(/not yet reconciled/)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByText('Exact historical originals (1)'));
  expect(screen.getByRole('rowheader', { name: 'loading-october.csv' })).toBeVisible();
  expect(screen.getByText('Partially succeeded')).toBeVisible();
  expect(screen.queryByRole('link', { name: /download|original/i })).not.toBeInTheDocument();
});

it('clears historical consent when another administrator changes the decision head', async () => {
  const firstPause = { ...decision, id: 'pause-a', action: 'pause', wholeFileConsent: false, expiresAt: null, supersedesId: decision.id };
  let current: SourceBackfill = { ...job, state: 'paused', decisions: [decision, firstPause], latestDecisionId: firstPause.id,
    capabilities: { approve: false, pause: false, resume: true, collect: false } };
  const request = vi.fn(async (path: string, _method?: string, _body?: unknown, _headers?: unknown): Promise<unknown> => path.includes('/source-backfills/') ? current : { jobs: [current], nextCursor: null });
  const user = userEvent.setup(); render(panel(request));
  await screen.findByRole('button', { name: 'Resume reviewed historical import' });
  await fillApproval(user);
  expect(screen.getByRole('button', { name: 'Resume reviewed historical import' })).toBeEnabled();
  current = { ...current, latestDecisionId: 'pause-b', decisions: [...current.decisions, { ...firstPause, id: 'pause-b', reason: 'Another administrator paused again', supersedesId: firstPause.id }] };
  await user.click(screen.getByRole('button', { name: 'Refresh historical imports' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ })).not.toBeChecked());
  expect(screen.getByRole('button', { name: 'Resume reviewed historical import' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ }));
  await user.click(screen.getByRole('button', { name: 'Resume reviewed historical import' }));
  expect(request.mock.calls.find(call => call[1] === 'POST')?.[2]).toMatchObject({ expectedDecisionId: 'pause-b' });
});

it('requires fresh complete-original consent and expiry when resuming an expired historical job', async () => {
  const current: SourceBackfill = { ...job, state: 'expired', decisions: [{ ...decision, expiresAt: '2026-11-01T00:00:00Z' }], latestDecisionId: decision.id, approvalExpiresAt: '2026-11-01T00:00:00Z', capabilities: { approve: false, pause: false, resume: true, collect: false } };
  const request = reads(current), user = userEvent.setup(); render(panel(request));
  const button = await screen.findByRole('button', { name: 'Resume reviewed historical import' });
  expect(button).toBeDisabled();
  await fillApproval(user);
  fireEvent.change(screen.getByLabelText('Historical import approval expires (your timezone)'), { target: { value: futureLocal(25) } });
  await user.click(screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ }));
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Historical import approval expires (your timezone)'), { target: { value: futureLocal() } });
  await user.click(screen.getByRole('checkbox', { name: /I reviewed these exact historical files/ }));
  await user.click(button);
  expect(request.mock.calls.find(call => call[1] === 'POST')?.[2]).toMatchObject({ action: 'resume', wholeFileConsent: true });
});

it('pauses only the historical job with a reason and preserves live source authority', async () => {
  const current: SourceBackfill = { ...job, state: 'approved', decisions: [decision], latestDecisionId: decision.id, capabilities: { approve: false, pause: true, resume: false, collect: true } };
  const request = reads(current), user = userEvent.setup(); render(panel(request));
  const button = await screen.findByRole('button', { name: 'Pause historical import' });
  expect(button).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'Reason for this historical import decision' }), 'Check the historical exporter');
  await user.click(button);
  expect(request.mock.calls.find(call => call[1] === 'POST')?.[2]).toEqual({ organizationId: 'org-a', environment: 'live', action: 'pause',
    manifestSha256: job.manifestSha256, configurationRevision: 2, grantRevision: 3, expectedDecisionId: decision.id, reason: 'Check the historical exporter' });
});

it('loads source history only on disclosure and preserves pagination for many historical jobs', async () => {
  const request = vi.fn(async (_path: string): Promise<unknown> => ({ jobs: [job], nextCursor: 'older-jobs' }));
  render(panel(request, { requestedJobId: null, requestedManifest: null }));
  expect(request).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByText('Historical imports'));
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Next historical import page' }));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith(`/source-subscriptions/source-a/backfills?${scope}&cursor=older-jobs`));
});
