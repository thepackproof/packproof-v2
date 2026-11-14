import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { SourceSubscriptionApproval, type SourceSubscription } from '../records/SourceSubscriptions';
import { SourcePolicies } from '../records/SourcePolicies';

const source: SourceSubscription = { id: 'source-a', subscriptionId: 'source-a', configurationRevision: 2, grantRevision: 3, state: 'proposed', installationId: 'computer-a', connectionId: 'wms-a', locationId: 'site-a', operatorMembershipId: 'member-a', configurationSha256: 'c'.repeat(64), lastCheckAt: null, sourceAsOf: null, updatedAt: '2026-11-14T01:00:00Z', heartbeat: {}, capabilities: { identityPolicies: true, rulePolicies: true }, config: { batchSchema: 'packproof.typed-source-batch/v2', transport: 'local_ntfs', displayName: 'Loading export', sourceProfile: 'packproof.operational-observations/v2', mappingVersion: 'loading/3', sourceNamespace: 'site-a-wms', mapping: { shipmentId: 'Shipment', property: 'Field', sourceSequence: 'Sequence', sourceAsOf: 'Snapshot', sourceEventId: 'Event', sourceRevision: 'Revision' }, constants: {}, wholeFileConsent: true, folderDigest: 'a'.repeat(64), initialFileName: 'loading.csv', initialOriginalSha256: 'b'.repeat(64), expectedHeaders: ['Shipment', 'Field', 'Sequence', 'Snapshot', 'Event', 'Revision'], historyFrom: '2026-11-14T00:00:00Z', historyTo: null, maxBytes: 2097152, maxRows: 1000, offlineWindowHours: 24, expectedIntervalSeconds: null, unknownTimePolicy: 'quarantine', completenessPolicy: { kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null } } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('does not fetch source policy choices unless a qualified editor is opened', async () => {
  const request = vi.fn();
  render(<SourcePolicies api={{ recordsRequest: request } as unknown as PackProofApi} source={{ ...source, capabilities: undefined }} organizationId="org-a" environment="live" onSaved={vi.fn()}/>);
  expect(screen.getByText(/No composite identity policy is approved/)).toBeVisible();
  expect(screen.queryByText('Change the source identity policy')).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('saves an ordered identity policy as a new revision and blocks stale source approval', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...source, configurationRevision: 3, configurationSha256: 'd'.repeat(64) } : source), user = userEvent.setup();
  render(<SourceSubscriptionApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="live" params={new URLSearchParams({ installationId: 'computer-a', subscriptionId: 'source-a', configurationRevision: '2' })} canManage/>);
  await user.click(await screen.findByText('Change the source identity policy'));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Stable source report identity' }), 'composite');
  await user.click(screen.getByRole('checkbox', { name: /Shipment reference/ }));
  await user.click(screen.getByRole('checkbox', { name: /Reported field/ }));
  expect(screen.getByRole('list', { name: 'Selected identity component order' })).toHaveTextContent('Shipment referenceReported field');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Revision comes from' }), 'source_as_of');
  await user.click(screen.getByRole('checkbox', { name: /The source owner confirmed these identity/ }));
  await user.click(screen.getByRole('button', { name: 'Save identity policy for review' }));
  expect(await screen.findByRole('link', { name: 'Review the exact new source revision' })).toHaveAttribute('href', expect.stringContaining('configurationRevision=3'));
  expect(screen.queryByRole('button', { name: 'Approve this source and first original' })).not.toBeInTheDocument();
  const writes = request.mock.calls as unknown as Array<[string, string, { action: string; configurationRevision: number; config: SourceSubscription['config'] }]>;
  const body = writes.find(([, method]) => method === 'POST')![2];
  expect(body.configurationRevision).toBe(2);
  expect(body.config.identityPolicy).toEqual({ schema: 'packproof.source-identity-policy/v1', eventKey: { kind: 'composite', fields: ['shipmentId', 'property'] }, revision: { kind: 'source_as_of' } });
  expect(body.config.expectedHeaders).toEqual(source.config.expectedHeaders);
});

it('requires explicit policy meanings and only selects source choices returned in current access', async () => {
  const partner = { ...source, id: 'source-b', subscriptionId: 'source-b', state: 'approved', config: { ...source.config, displayName: 'Carrier events', sourceNamespace: 'carrier-a' } };
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...source, configurationRevision: 3 } : { subscriptions: [partner], nextCursor: null }), user = userEvent.setup();
  render(<SourcePolicies api={{ recordsRequest: request } as unknown as PackProofApi} source={source} organizationId="org-a" environment="live" onSaved={vi.fn()}/>);
  expect(request).not.toHaveBeenCalled();
  await user.click(screen.getByText('Configure source-specific investigation rules'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/source-subscriptions?organizationId=org-a&environment=live'));
  await user.click(screen.getByRole('checkbox', { name: 'Review labels without a carrier acceptance observation' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Carrier acceptance source' }), 'source-b');
  for (const [name, value] of Object.entries({ 'Rule policy version': 'carrier-window/1', 'Source-owner qualification reference': 'owner-review-4', 'Shared package reference group': 'carrier-packages', 'Carrier code': 'carrier-a', 'Carrier account reference': 'site-a-account', 'Carrier service': 'ground', 'Expected carrier acceptance window in seconds': '3600', 'Carrier acceptance grace in seconds': '120', 'Source codes meaning label created': 'CREATED', 'Source codes meaning label voided': 'VOID', 'Source codes meaning carrier accepted': 'ACCEPTED' })) await user.type(screen.getByRole('textbox', { name }), value);
  const save = screen.getByRole('button', { name: 'Save investigation policy for review' });
  await user.click(screen.getByRole('checkbox', { name: 'Save these exact rules as a new source revision for separate approval.' }));
  expect(save).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /The source owner confirmed the exact status meanings/ }));
  expect(save).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'Save these exact rules as a new source revision for separate approval.' }));
  await user.click(save);
  const writes = request.mock.calls as unknown as Array<[string, string, { config: SourceSubscription['config'] }]>;
  await waitFor(() => expect(writes.some(([, method]) => method === 'POST')).toBe(true));
  expect(writes.find(([, method]) => method === 'POST')![2].config.rulePolicies?.labelAcceptance?.acceptanceSource).toEqual({ subscriptionId: 'source-b', sourceNamespace: 'carrier-a', configurationRevision: 2 });
});

it('keeps a self-bound investigation rule on the exact proposed revision when another policy changes', async () => {
  const { nextSourceConfig } = await import('../records/source-config-revision');
  const self = { subscriptionId: source.id, sourceNamespace: source.config.sourceNamespace, configurationRevision: 2 }, other = { subscriptionId: 'source-b', sourceNamespace: 'carrier-a', configurationRevision: 7 };
  const config = nextSourceConfig({ ...source, config: { ...source.config, rulePolicies: { schema: 'packproof.source-rule-policies/v1', version: 'policy/1', sourceOwnerQualified: true, qualificationReference: 'review-1', labelAcceptance: { labelSource: self, acceptanceSource: other, subjectNamespace: 'packages', carrier: { code: 'carrier-a', accountReference: 'site-a', service: 'ground' }, windowSeconds: 3600, graceSeconds: 0, labelCreatedValues: ['CREATED'], labelVoidedValues: [], acceptedValues: ['ACCEPTED'] } } } }, { mappingVersion: 'loading/4' });
  expect(config.rulePolicies!.labelAcceptance!.labelSource.configurationRevision).toBe(3);
  expect(config.rulePolicies!.labelAcceptance!.acceptanceSource.configurationRevision).toBe(7);
  expect(config.mappingVersion).toBe('loading/4');
});

it('requires explicit shared-source partition qualification before saving a cross-case policy', async () => {
  const current = { ...source, capabilities: { crossCase: true }, config: { ...source.config, identityPolicy: { schema: 'packproof.source-identity-policy/v1' as const, eventKey: { kind: 'column' as const }, revision: { kind: 'column' as const } } } };
  const request = vi.fn(async () => ({ ...current, configurationRevision: 3 })), user = userEvent.setup();
  render(<SourcePolicies api={{ recordsRequest: request } as unknown as PackProofApi} source={current} organizationId="org-a" environment="live" onSaved={vi.fn()}/>);
  await user.click(screen.getByText('Review shared load and carton source policy'));
  await user.type(screen.getByRole('textbox', { name: 'Shared source policy version' }), 'allocations/1');
  await user.type(screen.getByRole('textbox', { name: 'Shared allocation qualification reference' }), 'owner-review-1');
  await user.click(screen.getByRole('checkbox', { name: 'Loads' }));
  await user.click(screen.getByRole('checkbox', { name: 'Save this precise shared-source scope as a new revision for separate approval.' }));
  expect(screen.getByRole('button', { name: 'Save shared source policy for review' })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /The source owner confirmed explicit order and parent-line allocations/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Save this precise shared-source scope as a new revision for separate approval.' }));
  await user.click(screen.getByRole('button', { name: 'Save shared source policy for review' }));
  const writes = request.mock.calls as unknown as Array<[string, string, { config: SourceSubscription['config'] }]>;
  await waitFor(() => expect(writes.some(([, method]) => method === 'POST')).toBe(true));
  expect(writes.find(([, method]) => method === 'POST')![2].config.crossCasePolicy).toEqual({ schema: 'packproof.cross-case-source-policy/v1', version: 'allocations/1', allowMultiOrderRows: true, partitionRule: 'explicit_order_line_allocations', sharedEntityTypes: ['load'], sourceOwnerQualified: true, qualificationReference: 'owner-review-1' });
});

it.each(['packproof.order-lines/v1', 'packproof.shipment-handling-units/v1'])('preserves the real %s profile when adopting the v2 identity transport', async (sourceProfile) => {
  const current: SourceSubscription = { ...source, capabilities: { identityPolicies: true }, config: { ...source.config, sourceProfile, batchSchema: undefined, identityPolicy: undefined, mapping: { sourceEventId: 'Event', sourceRevision: 'Revision', orderId: 'Order', orderLineId: 'Line', shipmentId: 'Shipment', property: 'Meaning' }, expectedHeaders: ['Event', 'Revision', 'Order', 'Line', 'Shipment', 'Meaning'] } };
  const request = vi.fn(async () => ({ ...current, configurationRevision: 3 })), user = userEvent.setup();
  render(<SourcePolicies api={{ recordsRequest: request } as unknown as PackProofApi} source={current} organizationId="org-a" environment="live" onSaved={vi.fn()}/>);
  await user.click(screen.getByText('Change the source identity policy'));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Stable source report identity' }), 'composite');
  for (const name of [/Order number —/, /Order line —/, /Reported field meaning —/, ...(sourceProfile.includes('shipment-handling') ? [/Shipment reference —/] : [])]) await user.click(screen.getByRole('checkbox', { name }));
  await user.click(screen.getByRole('checkbox', { name: /The source owner confirmed these identity/ }));
  await user.click(screen.getByRole('button', { name: 'Save identity policy for review' }));
  const writes = request.mock.calls as unknown as Array<[string, string, { config: SourceSubscription['config'] }]>;
  await waitFor(() => expect(writes.some(([, method]) => method === 'POST')).toBe(true));
  const config = writes.find(([, method]) => method === 'POST')![2].config;
  expect(config.batchSchema).toBe('packproof.typed-source-batch/v2');
  expect(config.sourceProfile).toBe(sourceProfile);
  expect(config.identityPolicy!.eventKey).toEqual({ kind: 'composite', fields: ['orderId', 'orderLineId', 'property', ...(sourceProfile.includes('shipment-handling') ? ['shipmentId'] : [])] });
});
