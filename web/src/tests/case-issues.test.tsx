import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { CaseIssues } from '../records/CaseIssues';

const issue = { id: 'issue-a', category: 'quantity', status: 'open', assigneeMembershipId: null, createdAt: '2026-11-14T01:00:00Z', evaluatedAt: '2026-11-14T02:00:00Z', evaluation: { title: 'Reported quantities differ', explanation: '10 each allocated and 8 each loaded.', inputAssertionIds: ['allocated', 'loaded'], outcome: 'different' } };
const list = { issues: [issue], total: 1, nextAfter: null, enabled: true };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function panel(api: PackProofApi, role = 'OPERATOR', onSource = vi.fn()) { return <CaseIssues api={api} caseId="case-a" organizationId="org-a" environment="live" role={role} revision={0} onSource={onSource}/>; }

it('records a reasoned review with stable idempotency after a lost response', async () => {
  let writes = 0;
  const request = vi.fn(async (_path: string, method?: string) => { if (method === 'POST') { if (!writes++) throw new Error('Response interrupted'); return { id: 'action-a' }; } return list; });
  const user = userEvent.setup(); render(panel({ recordsRequest: request } as unknown as PackProofApi));
  const submit = await screen.findByRole('button', { name: 'Record investigation decision' });
  expect(submit).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Review decision' }), 'resolve');
  await user.type(screen.getByRole('textbox', { name: 'Reason for this decision' }), 'Reviewed the approved loading correction.');
  await user.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('Response interrupted');
  await user.click(submit);
  await waitFor(() => expect(writes).toBe(2));
  const calls = request.mock.calls as unknown as Array<[string, string, unknown, Record<string, string>]>;
  const commands = calls.filter(([, method]) => method === 'POST');
  expect(commands[0].slice(0, 3)).toEqual(['/cases/case-a/issues/issue-a/actions?organizationId=org-a&environment=live', 'POST', { action: 'resolve', reason: 'Reviewed the approved loading correction.' }]);
  expect(commands[0][3]['Idempotency-Key']).toBe(commands[1][3]['Idempotency-Key']);
});

it('keeps reviewers read only while exposing paginated preserved evaluations', async () => {
  const onSource = vi.fn(), request = vi.fn(async (path: string) => path.includes('/history?') ? { entries: [{ id: 'evaluation-a', sequence: 1, created_at: '2026-11-14T01:00:00Z', evaluation: issue.evaluation }], total: 65, nextAfter: 50 } : list);
  const user = userEvent.setup(); render(panel({ recordsRequest: request } as unknown as PackProofApi, 'REVIEWER', onSource));
  expect(await screen.findByRole('heading', { name: 'Reported quantities differ' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Record investigation decision' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Open finding history' }));
  expect(await screen.findByText('1 shown of 65 history entries')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Open historical source 2' }));
  expect(onSource).toHaveBeenCalledWith('loaded');
  await user.click(screen.getByRole('button', { name: 'Next history page' }));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('/cases/case-a/issues/issue-a/history?organizationId=org-a&environment=live&section=evaluations&limit=50&after=50'));
});

it('assigns a current named workspace member only after an administrator chooses them and supplies a reason', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { id: 'assignment-a' } : list);
  const organizationRequest = vi.fn(async () => ({ memberships: [{ id: 'member-b', userId: 'user-b', displayName: 'Warehouse lead', revokedAt: null }, { id: 'revoked', userId: 'old', displayName: 'Former member', revokedAt: '2026-11-01T00:00:00Z' }] }));
  const user = userEvent.setup(); render(panel({ recordsRequest: request, organizationRequest } as unknown as PackProofApi, 'OWNER'));
  await user.click(await screen.findByRole('button', { name: 'Assign a teammate' }));
  expect(await screen.findByRole('option', { name: 'Warehouse lead' })).toBeVisible();
  expect(screen.queryByRole('option', { name: 'Former member' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Responsible teammate' }), 'member-b');
  expect(screen.getByRole('button', { name: 'Save case assignment' })).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'Reason for this decision' }), 'Lead will check loading records.');
  await user.click(screen.getByRole('button', { name: 'Save case assignment' }));
  const calls = request.mock.calls as unknown as Array<[string, string, unknown]>;
  expect(calls.find(([, method]) => method === 'POST')![2]).toEqual({ action: 'assign', reason: 'Lead will check loading records.', membershipId: 'member-b' });
  expect(organizationRequest).toHaveBeenCalledWith('org-a', '/administration');
});

it('keeps findings beyond the first fifty reachable without conflating no findings with unavailable data', async () => {
  const request = vi.fn(async (_path: string) => ({ ...list, total: 101, nextAfter: 'issue-50' }));
  render(panel({ recordsRequest: request } as unknown as PackProofApi));
  expect(await screen.findByText('1 shown of 101 permitted findings')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next findings page' }));
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('/cases/case-a/issues?organizationId=org-a&environment=live&limit=50&after=issue-50'));
});
