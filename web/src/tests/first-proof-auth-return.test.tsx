import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { clearSession, loadSession, saveSession, type WebSession } from '../auth/session';
import { readReauthenticationTask, reauthenticationDestination, retainReauthenticationTask, safeTaskPath } from '../first-experience/auth-return';
import { HomeScreen } from '../screens/HomeScreen';
import { invitation } from './fixtures';

const signin = vi.hoisted(() => ({ next: null as WebSession | null }));
vi.mock('../screens/SignInScreen', () => ({ SignInScreen: ({ onSignedIn }: { onSignedIn: (session: WebSession) => void }) => <button onClick={() => onSignedIn(signin.next!)}>Test reauthenticate</button> }));
const account: WebSession = { apiBaseUrl: '', authMode: 'dev', userId: 'user_buyer', username: 'buyer', displayName: 'Buyer', token: 'old-fixture', refreshToken: null, accessExpiresAt: null, subject: 'fixture' };

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); history.replaceState({}, '', '/app'); vi.stubEnv('VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE', 'true'); signin.next = { ...account, token: 'renewed-fixture' }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function server() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/invitations')) {
      if (new Headers(init?.headers).get('authorization') === 'Bearer old-fixture') return json({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401);
      return json({ invitations: [invitation] });
    }
    return json({ proofs: [], items: [], connections: [], sources: [], onboarding_completed: true, onboarding_enrolled: false });
  });
}

it('returns to the same invitation after an expired session and fresh authentication', async () => {
  saveSession(account); history.replaceState({}, '', `/invitations/${invitation.invitationId}`); vi.stubGlobal('fetch', server());
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test reauthenticate' }));
  expect(await screen.findByRole('heading', { name: 'You’ve been added to a PackProof' })).toBeInTheDocument();
  expect(location.pathname).toBe(`/invitations/${invitation.invitationId}`);
  expect(readReauthenticationTask()).toBeNull();
});

it('does not resume the previous account task when a different account signs in', async () => {
  saveSession(account); history.replaceState({}, '', `/invitations/${invitation.invitationId}`); vi.stubGlobal('fetch', server());
  signin.next = { ...account, userId: 'another-account', token: 'renewed-fixture' };
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test reauthenticate' }));
  await waitFor(() => expect(location.pathname).toBe('/app'));
  expect(screen.queryByRole('heading', { name: 'You’ve been added to a PackProof' })).not.toBeInTheDocument();
});

it('explicit sign-out clears task return and the visible account even when invoked by a button event', async () => {
  saveSession({ ...account, token: 'renewed-fixture' }); history.replaceState({}, '', `/invitations/${invitation.invitationId}`); vi.stubGlobal('fetch', server());
  retainReauthenticationTask(account, '/receipt/previous');
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(location.pathname).toBe('/');
  expect(loadSession()).toBeNull();
  expect(readReauthenticationTask()).toBeNull();
});

it('keeps only a versioned account-scoped locator and never bearer data or submission authorization', () => {
  const task = retainReauthenticationTask(account, '/proofs/proof_1/capture?token=secret&submit=true#signed-payload');
  expect(task).toEqual({ version: 1, userId: account.userId, apiBaseUrl: '', path: '/proofs/proof_1/capture' });
  expect(JSON.stringify(readReauthenticationTask())).not.toContain('secret');
  expect(safeTaskPath('/p/bearer')).toBeNull();
  expect(safeTaskPath('//outside.test/new')).toBeNull();
  expect(reauthenticationDestination(task!, { ...account, apiBaseUrl: '/other-api' })).toBe('/app');
  expect(safeTaskPath('/receipt/proof_1')).toBe('/receipt/proof_1');
  expect(safeTaskPath('/new?reference=order-1&token=secret')).toBe('/new?reference=order-1');
});

it('keeps active authentication and its nonsecret locator usable when storage throws', () => {
  vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  vi.spyOn(sessionStorage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  expect(() => saveSession(account)).not.toThrow();
  expect(() => clearSession()).not.toThrow();
  expect(loadSession()).toBeNull();
  expect(retainReauthenticationTask(account, '/receipt/proof_1')?.path).toBe('/receipt/proof_1');
});

const home = { firstExperience: true, firstProof: false, reconciled: false, proofs: [], queue: [], connections: [], loading: false, error: null, onRetry: vi.fn(), onGo: vi.fn(), onOpenProof: vi.fn(), onOpenInvitation: vi.fn(), onOpenReceiver: vi.fn() };
it('shows unknown local recovery as a workspace check rather than a first-use or empty account', () => {
  render(<HomeScreen {...home} pendingUploadCount={undefined} />);
  expect(screen.getByRole('heading', { name: 'Check your workspace' })).toBeInTheDocument();
  expect(screen.queryByText('No Proofs yet')).not.toBeInTheDocument();
  expect(screen.queryByText('Create your first Proof')).not.toBeInTheDocument();
});
it('keeps pending local work visible without calling an empty server list the first Proof', () => {
  render(<HomeScreen {...home} pendingUploadCount={2} />);
  expect(screen.getByText('2 pending')).toBeInTheDocument();
  expect(screen.queryByText('Create your first Proof')).not.toBeInTheDocument();
  expect(screen.queryByText('No Proofs yet')).not.toBeInTheDocument();
});
