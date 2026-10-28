import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProofSearchQuery } from '../../../packages/evidence-contracts/api-dashboard';
import { App } from '../App';
import { saveSession } from '../auth/session';

vi.mock('../screens/ClientProofDashboard', () => ({
  ClientProofDashboard: (props: {
    accountKey?: string; initialFilters?: ProofSearchQuery; refreshVersion?: number;
    readyOrders?: import('react').ReactNode; onFiltersChange?: (filters: ProofSearchQuery) => void;
  }) => <section aria-label="Dashboard integration fixture">
    <output data-testid="dashboard-filters">{JSON.stringify(props.initialFilters)}</output>
    <output data-testid="dashboard-account">{props.accountKey}</output>
    <output data-testid="dashboard-refresh">{props.refreshVersion}</output>
    {props.readyOrders}
    <button onClick={() => props.onFiltersChange?.({ q: 'next order', state: 'AWAITING_CAPTURE', from: '2026-10-02', connectionId: 'connection_next', limit: 50 })}>Apply dashboard filters</button>
  </section>,
}));
vi.mock('../components/ReadyIntakeOrders', () => ({ ReadyIntakeOrders: () => <p>Ready order intake preserved</p> }));
vi.mock('../onboarding/Onboarding', () => ({ Onboarding: () => null }));
vi.mock('../mobile-task/useMobileTaskExperience', () => ({ useMobileTaskExperience: () => false }));

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  vi.stubEnv('VITE_PACKPROOF_CLIENT_DASHBOARD', 'true');
  history.replaceState({}, '', '/proofs?filter=completed&q=ORDER-1&from=2026-10-01&through=2026-10-28&connectionId=connection_a');
  saveSession({ apiBaseUrl: '', authMode: 'dev', userId: 'user_dashboard', username: 'dashboard', displayName: 'Dashboard user', token: 'fixture', refreshToken: null, accessExpiresAt: null, subject: 'fixture' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('passes bounded URL filters and account context without loading every legacy Proof page', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => json({}));
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  await screen.findByRole('region', { name: 'Dashboard integration fixture' });
  expect(JSON.parse(screen.getByTestId('dashboard-filters').textContent!)).toMatchObject({
    q: 'ORDER-1', state: 'READY', from: '2026-10-01', through: '2026-10-28', connectionId: 'connection_a', limit: 50,
  });
  expect(screen.getByTestId('dashboard-account')).toHaveTextContent(':user_dashboard');
  expect(screen.getByText('Ready order intake preserved')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled());
  expect(fetcher.mock.calls.some(([input]) => new URL(String(input), location.origin).pathname === '/me/proofs')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
  await waitFor(() => expect(screen.getByTestId('dashboard-refresh')).toHaveTextContent('1'));
});

it('writes full filter history and applies browser history changes to the dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({})));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Apply dashboard filters' }));
  expect(location.pathname + location.search).toBe('/proofs?filter=all&state=AWAITING_CAPTURE&q=next+order&from=2026-10-02&connectionId=connection_next');
  await waitFor(() => expect(JSON.parse(screen.getByTestId('dashboard-filters').textContent!)).toMatchObject({ state: 'AWAITING_CAPTURE', q: 'next order', from: '2026-10-02', connectionId: 'connection_next' }));
  history.replaceState({}, '', '/proofs?filter=attention&q=previous&through=2026-10-20');
  fireEvent.popState(window);
  await waitFor(() => expect(JSON.parse(screen.getByTestId('dashboard-filters').textContent!)).toMatchObject({ state: 'NEEDS_ATTENTION', q: 'previous', through: '2026-10-20' }));
  expect(JSON.parse(screen.getByTestId('dashboard-filters').textContent!)).not.toHaveProperty('connectionId');
});
