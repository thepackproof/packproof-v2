import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DASHBOARD_TOUR_STEPS, DashboardTour, replayDashboardTour } from '../screens/dashboard-tour';
import { ClientProofDashboard } from '../screens/ClientProofDashboard';
import type { PackProofApi } from '../api/client';
import { Onboarding } from '../onboarding/Onboarding';
import { STEPS, type OnboardingState } from '../../../packages/onboarding/model';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const key = (account: string) => `packproof:dashboard-tour:v1:${encodeURIComponent(account)}`;
function workspace(accountKey: string, ready = true) {
  return <section><button type="button">Outside action</button>{DASHBOARD_TOUR_STEPS.map(step => <section key={step.target} data-dashboard-tour={step.target}>{step.target}</section>)}<DashboardTour accountKey={accountKey} ready={ready} /></section>;
}

it('invites a first-time user and explains the real workspace without creating a record', async () => {
  render(workspace('first-time'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: 'Dashboard introduction' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('dialog', { name: 'Find the right shipment' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(key('first-time'))!)).toEqual({ version: 1, status: 'started', step: 0 });
});

it('resumes the saved step after navigation and keeps completion scoped to the account', () => {
  const first = render(workspace('resume-account'));
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  first.unmount();
  render(workspace('resume-account'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume tour' }));
  expect(screen.getByRole('dialog', { name: 'Narrow down your work' })).toBeInTheDocument();
  for (let step = 2; step < DASHBOARD_TOUR_STEPS.length - 1; step++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Finish tour' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: 'Dashboard introduction' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(key('resume-account'))!).status).toBe('completed');
  fireEvent.click(screen.getByRole('button', { name: 'Take dashboard tour' }));
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toBeInTheDocument();
});

it('remembers Maybe later and Skip, and allows replay after either dismissal', () => {
  const view = render(workspace('dismiss-account'));
  fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  view.unmount();
  render(workspace('dismiss-account'));
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Take dashboard tour' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
  fireEvent.click(screen.getByRole('button', { name: 'Take dashboard tour' }));
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toBeInTheDocument();
});

it('traps keyboard focus, dismisses with Escape and restores the trigger focus and background', () => {
  const view = render(workspace('keyboard-account'));
  const trigger = screen.getByRole('button', { name: 'Start dashboard tour' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  const skip = within(dialog).getByRole('button', { name: 'Skip tour' }), next = within(dialog).getByRole('button', { name: 'Next' });
  expect(view.container.inert).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(skip).toHaveFocus();
  fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
  expect(next).toHaveFocus();
  fireEvent.keyDown(next, { key: 'Tab' });
  expect(skip).toHaveFocus();
  screen.getByRole('button', { name: 'Outside action' }).focus();
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(skip, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(view.container.inert).not.toBe(true);
  // The first-visit invitation was dismissed, so the persistent replay control takes focus.
  expect(screen.getByRole('button', { name: 'Take dashboard tour' })).toHaveFocus();
  expect(JSON.parse(localStorage.getItem(key('keyboard-account'))!).status).toBe('dismissed');
});

it('does not compete with the existing app tutorial and pauses if another dialog opens', async () => {
  const blocker = document.createElement('div');
  blocker.setAttribute('role', 'dialog'); blocker.setAttribute('aria-label', 'App tutorial');
  document.body.append(blocker);
  try {
    render(workspace('other-dialog'));
    expect(screen.getByRole('button', { name: 'Take dashboard tour' })).toBeDisabled();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    act(() => replayDashboardTour());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    act(() => blocker.remove());
    await screen.findByRole('button', { name: 'Start dashboard tour' });
    fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
    expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toBeInTheDocument();
    act(() => document.body.append(blocker));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your shipment workspace' })).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(key('other-dialog'))!).status).toBe('started');
  } finally { blocker.remove(); }
});

it('resets the visible tour on account changes and waits until the workspace is ready', () => {
  const view = render(workspace('account-one', false));
  expect(screen.getByRole('button', { name: 'Take dashboard tour' })).toBeDisabled();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  view.rerender(workspace('account-one'));
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  view.rerender(workspace('account-two'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start dashboard tour' })).toBeInTheDocument();
  expect(localStorage.getItem(key('account-two'))).toBeNull();
});

it('works without storage, ignores malformed persisted data and never traps users at a missing target', () => {
  localStorage.setItem(key('malformed-account'), '{"version":1,"status":"started","step":9999}');
  render(<DashboardTour accountKey="malformed-account" />);
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  expect(screen.getByText(/You can continue the tour/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  cleanup();
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  const view = render(workspace('storage-disabled'));
  fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
  view.unmount();
  render(workspace('storage-disabled'));
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Take dashboard tour' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('supports a replay request and observes completion or dismissal from another tab', async () => {
  render(workspace('cross-tab'));
  fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
  act(() => replayDashboardTour());
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toBeInTheDocument();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: key('cross-tab'), newValue: JSON.stringify({ version: 1, status: 'completed', step: 5 }) })));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

it('highlights the current workspace control and follows viewport changes', () => {
  render(workspace('spotlight-account'));
  const target = document.querySelector<HTMLElement>('[data-dashboard-tour="overview"]')!;
  const bounds = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ x: 80, y: 80, left: 80, top: 80, right: 280, bottom: 140, width: 200, height: 60, toJSON: () => ({}) });
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  const spotlight = document.querySelector<HTMLElement>('.dashboard-tour-spotlight')!;
  expect(spotlight.style.left).toBe('74px');
  expect(spotlight.style.width).toBe('212px');
  bounds.mockReturnValue({ x: 100, y: 100, left: 100, top: 100, right: 300, bottom: 160, width: 200, height: 60, toJSON: () => ({}) });
  fireEvent(window, new Event('resize'));
  expect(spotlight.style.left).toBe('94px');
});

it('guides the real empty dashboard without invoking shipment or connection actions', async () => {
  const searchProofs = vi.fn().mockResolvedValue({ apiVersion: 'v1', schema: 'packproof.proof-search/v1', proofs: [], nextCursor: null, hasMore: false, refreshedAt: '2026-10-28T12:00:00Z', cursorExpiresAt: '2026-10-28T13:00:00Z' });
  const listCommerceConnections = vi.fn().mockResolvedValue({ connections: [] });
  const onCreate = vi.fn(), onOpenProof = vi.fn(), onOpenConnections = vi.fn();
  render(<ClientProofDashboard api={{ searchProofs, listCommerceConnections } as unknown as PackProofApi} accountKey="real-empty-workspace" onCreate={onCreate} onOpenProof={onOpenProof} onOpenConnections={onOpenConnections} />);
  await screen.findByRole('button', { name: 'Start dashboard tour' });
  for (const step of DASHBOARD_TOUR_STEPS) expect(document.querySelectorAll(`[data-dashboard-tour="${step.target}"]`)).toHaveLength(1);
  for (const step of STEPS) expect(document.querySelector(`[data-onboarding~="${step.target}"]`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  for (let step = 0; step < DASHBOARD_TOUR_STEPS.length; step++) {
    expect(screen.getByRole('dialog', { name: DASHBOARD_TOUR_STEPS[step].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: step === DASHBOARD_TOUR_STEPS.length - 1 ? 'Finish tour' : 'Next' }));
  }
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(onCreate).not.toHaveBeenCalled();
  expect(onOpenProof).not.toHaveBeenCalled();
  expect(onOpenConnections).not.toHaveBeenCalled();
  expect(searchProofs).toHaveBeenCalledTimes(1);
  expect(listCommerceConnections).toHaveBeenCalledTimes(1);
});

it('defers delayed app onboarding until the dashboard tour closes and restores the usable background', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const fresh: OnboardingState = { onboarding_completed: false, onboarding_version: 0, first_proof_coaching_completed: false, onboarding_last_step: 0, onboarding_enrolled: true, current_version: 1, first_proof_id: null, first_proof_completed: false };
  let deliver!: (state: OnboardingState) => void;
  const delayed = new Promise<OnboardingState>(resolve => { deliver = resolve; });
  const getOnboarding = vi.fn().mockReturnValue(delayed);
  const updateOnboarding = vi.fn().mockResolvedValue(fresh);
  const view = render(<><Onboarding api={{ getOnboarding, updateOnboarding }} accountKey="delayed-generic" dashboard onDashboard={vi.fn()} onCreate={vi.fn()} onViewProof={vi.fn()} />{workspace('delayed-dashboard')}</>);
  await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Start dashboard tour' }));
  await act(async () => { deliver(fresh); await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Your shipment workspace' })).toHaveFocus();
  expect(view.container.inert).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
  const generic = await screen.findByRole('dialog', { name: 'Create your first Proof' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(generic).toHaveFocus();
  expect(view.container.inert).toBe(true);
  fireEvent.click(within(generic).getByRole('button', { name: 'Skip' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(view.container.inert).not.toBe(true);
  expect(screen.getByRole('button', { name: 'Take dashboard tour' })).toBeEnabled();
});
