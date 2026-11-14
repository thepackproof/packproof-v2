import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { SourceCompletenessPolicy } from '../records/SourceCompletenessPolicy';
import type { SourceConfig, SourceSubscription } from '../records/SourceSubscriptions';

const headers = ['Order', 'Line', 'Quantity', 'Unit', 'Snapshot At', ' Export mArKer ', 'Export As Of', 'Export Data Rows'];
const boundary = { schema: 'packproof.csv-snapshot-boundary/v1' as const, markerColumn: ' Export mArKer ', asOfColumn: 'Export As Of', rowCountColumn: 'Export Data Rows' };
const source: SourceSubscription = {
  id: 'source-a', subscriptionId: 'source-a', configurationRevision: 2, grantRevision: 3, state: 'active', installationId: 'computer-a', connectionId: 'erp-a', locationId: 'site-a', operatorMembershipId: 'member-a', configurationSha256: 'c'.repeat(64), lastCheckAt: null, sourceAsOf: null, updatedAt: '2026-11-14T01:00:00Z', heartbeat: {}, capabilities: { csvSnapshotBoundary: true },
  config: { batchSchema: 'packproof.typed-source-batch/v2', transport: 'local_ntfs', displayName: 'Order snapshot export', sourceProfile: 'packproof.order-lines/v1', mappingVersion: 'orders/3', sourceNamespace: 'site-a-erp', mapping: { orderId: 'Order', orderLineId: 'Line', amount: 'Quantity', unit: 'Unit', sourceAsOf: 'Snapshot At' }, constants: { observationKind: 'snapshot', property: 'orderedQuantity', timeQuality: 'snapshot_time_only' }, identityPolicy: { schema: 'packproof.source-identity-policy/v1', eventKey: { kind: 'composite', fields: ['orderId', 'orderLineId', 'property'] }, revision: { kind: 'source_as_of' } }, wholeFileConsent: true, folderDigest: 'a'.repeat(64), initialFileName: 'orders.csv', initialOriginalSha256: 'b'.repeat(64), expectedHeaders: headers, historyFrom: '2026-11-01T00:00:00Z', historyTo: null, maxBytes: 2097152, maxRows: 1000, offlineWindowHours: 24, expectedIntervalSeconds: 3600, unknownTimePolicy: 'quarantine', completenessPolicy: { kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null } },
};
const ownerConsent = 'The source owner confirmed these exporter controls describe the complete snapshot for this inventory scope.';
const saveConsent = 'Save these exact completeness controls as a new source revision for separate approval.';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(current = source) {
  const request = vi.fn(async (_path: string, method?: string, body?: unknown) => method === 'POST' ? { ...current, configurationRevision: current.configurationRevision + 1, grantRevision: current.grantRevision + 1, configurationSha256: 'd'.repeat(64), state: 'proposed', config: (body as { config: SourceConfig }).config } : current);
  const onSaved = vi.fn(), api = { recordsRequest: request } as unknown as PackProofApi;
  const view = render(<SourceCompletenessPolicy api={api} source={current} organizationId="org-a" environment="live" onSaved={onSaved}/>);
  return { request, onSaved, view, api, user: userEvent.setup() };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Configure snapshot completeness controls'));
}
async function selectControls(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot marker column' }), boundary.markerColumn);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot as-of column' }), boundary.asOfColumn);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot data-row count column' }), boundary.rowCountColumn);
}

it('keeps snapshot controls unknown and supplies no invented control columns or values', async () => {
  const { request, user } = setup();
  expect(screen.getByText(/Snapshot controls are unknown/)).toBeVisible();
  await open(user);
  expect(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' })).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  for (const name of ['Snapshot marker column', 'Snapshot as-of column', 'Snapshot data-row count column']) expect(screen.getByRole('combobox', { name })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' })).toHaveValue('');
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Save completeness policy for review' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});

it('requires three distinct exact approved headers before qualified consent can save', async () => {
  const { request, user } = setup();
  await open(user);
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  const marker = screen.getByRole('combobox', { name: 'Snapshot marker column' });
  expect([...marker.querySelectorAll('option')].map(option => option.value).filter(Boolean)).toEqual(headers);
  expect(screen.queryByRole('option', { name: /^invented-marker$/ })).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' }), 'source-owner-review/4');
  await user.click(screen.getByRole('checkbox', { name: ownerConsent }));
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  const save = screen.getByRole('button', { name: 'Save completeness policy for review' });
  expect(save).toBeDisabled();
  await user.selectOptions(marker, boundary.markerColumn);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot as-of column' }), boundary.markerColumn);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot data-row count column' }), boundary.rowCountColumn);
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  expect(save).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot as-of column' }), boundary.asOfColumn);
  expect(screen.getByRole('checkbox', { name: saveConsent })).not.toBeChecked();
  expect(request).not.toHaveBeenCalled();
});

it('saves only source column bindings in a new immutable configuration review without changing the queued grant', async () => {
  const { request, onSaved, user } = setup();
  await open(user);
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  await selectControls(user);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot inventory scope' }), 'shipment_line');
  const save = screen.getByRole('button', { name: 'Save completeness policy for review' });
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  expect(save).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' }), 'owner-qualified-export/4');
  await user.click(screen.getByRole('checkbox', { name: ownerConsent }));
  expect(save).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  expect(save).toBeEnabled();
  await user.tab();
  expect(save).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const writes = request.mock.calls as unknown as Array<[string, string, { organizationId: string; environment: string; action: string; configurationRevision: number; config: SourceConfig }, Record<string, string>]>;
  const call = writes.find(([, method]) => method === 'POST')!;
  expect(call[0]).toBe('/source-subscriptions/source-a/actions?organizationId=org-a&environment=live');
  expect(call[2]).toEqual({ organizationId: 'org-a', environment: 'live', action: 'revise', configurationRevision: 2, config: { ...source.config, completenessPolicy: { kind: 'snapshot', scope: 'shipment_line', sourceOwnerQualified: true, qualificationReference: 'owner-qualified-export/4', fileBoundary: boundary } } });
  expect(call[2]).not.toHaveProperty('grantRevision');
  expect(call[3]['Idempotency-Key']).toBeTruthy();
  expect(onSaved.mock.calls[0][0].grantRevision).toBe(4);
  expect(source.grantRevision).toBe(3);
  expect(call[2].config.completenessPolicy.fileBoundary).not.toHaveProperty('marker');
  expect(call[2].config.completenessPolicy.fileBoundary).not.toHaveProperty('asOf');
  expect(call[2].config.completenessPolicy.fileBoundary).not.toHaveProperty('rowCount');
});

it('invalidates save consent after a qualification or control change', async () => {
  const { user, request } = setup();
  await open(user);
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  await selectControls(user);
  await user.type(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' }), 'review/1');
  await user.click(screen.getByRole('checkbox', { name: ownerConsent }));
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  expect(screen.getByRole('button', { name: 'Save completeness policy for review' })).toBeEnabled();
  await user.type(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' }), '-updated');
  expect(screen.getByRole('checkbox', { name: saveConsent })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save completeness policy for review' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});

it('requires a fresh review after the immutable source configuration revision changes', async () => {
  const { user, request, view, api } = setup();
  await open(user);
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  await selectControls(user);
  await user.type(screen.getByRole('textbox', { name: 'Snapshot completeness qualification reference' }), 'review/1');
  await user.click(screen.getByRole('checkbox', { name: ownerConsent }));
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  expect(screen.getByRole('button', { name: 'Save completeness policy for review' })).toBeEnabled();
  view.rerender(<SourceCompletenessPolicy api={api} source={{ ...source, configurationRevision: 3, configurationSha256: 'd'.repeat(64) }} organizationId="org-a" environment="live" onSaved={vi.fn()}/>);
  await open(user);
  expect(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: saveConsent })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save completeness policy for review' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ['unsupported collector capability', { ...source, capabilities: { csvSnapshotBoundary: false } }],
  ['legacy batch schema', { ...source, config: { ...source.config, batchSchema: 'packproof.typed-source-batch/v1' as const, identityPolicy: undefined, mapping: { ...source.config.mapping, sourceEventId: 'Event', sourceRevision: 'Revision' }, expectedHeaders: [...headers, 'Event', 'Revision'] } }],
  ['revoked source', { ...source, state: 'revoked' as const }],
  ['partner transport', { ...source, config: { ...source.config, transport: 'partner_api' as const, folderDigest: null, initialFileName: null, initialOriginalSha256: null } }],
])('does not advertise a completeness editor for an %s', (_label, current) => {
  const { request } = setup(current);
  expect(screen.queryByText('Configure snapshot completeness controls')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save completeness policy for review' })).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('keeps the exact existing boundary inspectable when a matching collector capability is unavailable', () => {
  const current: SourceSubscription = { ...source, capabilities: { csvSnapshotBoundary: false }, config: { ...source.config, completenessPolicy: { kind: 'snapshot', scope: 'shipment_line', sourceOwnerQualified: true, qualificationReference: 'owner-review/1', fileBoundary: boundary } } };
  const { request } = setup(current);
  expect(screen.getByText(/Export mArKer/)).toBeVisible();
  expect(screen.getByText(/Export As Of/)).toBeVisible();
  expect(screen.getByText(/Export Data Rows/)).toBeVisible();
  expect(screen.queryByText('Configure snapshot completeness controls')).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('removes the boundary only through an explicit new revision with an unknown completeness policy', async () => {
  const current: SourceSubscription = { ...source, config: { ...source.config, completenessPolicy: { kind: 'snapshot', scope: 'shipment_line', sourceOwnerQualified: true, qualificationReference: 'owner-review/1', fileBoundary: boundary } } };
  const { request, user } = setup(current);
  await open(user);
  await user.click(screen.getByRole('checkbox', { name: 'Use existing exporter snapshot control columns' }));
  await user.click(screen.getByRole('checkbox', { name: saveConsent }));
  await user.click(screen.getByRole('button', { name: 'Save completeness policy for review' }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  const writes = request.mock.calls as unknown as Array<[string, string, { config: SourceConfig }]>;
  expect(writes.find(([, method]) => method === 'POST')![2].config.completenessPolicy).toEqual({ kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null });
});
