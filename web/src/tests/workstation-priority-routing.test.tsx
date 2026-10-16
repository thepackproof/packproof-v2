import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { saveSession } from '../auth/session';
import { summary, canonicalProof } from './fixtures';
import type { LocalRecordingSummary } from '../capture-queue';

vi.mock('../screens/PackingStationScreen', () => ({ PackingStationScreen: (props: { onCaptureActive: (active:boolean)=>void }) => <section aria-label="Capture fixture"><button onClick={()=>props.onCaptureActive(true)}>Start test take</button><button onClick={()=>props.onCaptureActive(false)}>Finish test take</button></section> }));

const queue = vi.hoisted(() => ({ list: vi.fn(async (): Promise<LocalRecordingSummary[]> => []) }));
vi.mock('../capture-queue', async original => ({ ...await original<typeof import('../capture-queue')>(), listRecoverableRecordings: queue.list, resumeLocalRecordings: vi.fn(async () => undefined) }));
vi.mock('../analytics/study-capture', async original => ({ ...await original<typeof import('../analytics/study-capture')>(), flushStudyTimings: vi.fn(async () => undefined) }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const ready = { ...canonicalProof, status: 'READY_FOR_EVIDENCE', evidence: [] };
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); queue.list.mockReset().mockResolvedValue([]);
  vi.stubEnv('VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE', 'true');
  window.history.replaceState({}, '', '/app');
  Object.defineProperties(HTMLDialogElement.prototype, { close: { configurable: true, value() { this.removeAttribute('open'); } }, showModal: { configurable: true, value() { this.setAttribute('open', ''); } } });
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true }));
  saveSession({ apiBaseUrl: '', authMode: 'dev', userId: 'user_seller', username: 'seller', displayName: 'Seller', token: 'fixture', refreshToken: null, accessExpiresAt: null, subject: 'seller' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function mockApi(detail: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/me/proofs') return json({ proofs: [summary] });
    if (path === '/me/fulfillment-queue') return json({ items: [] });
    if (path === '/me/integration-connections') return json({ connections: [] });
    if (path === '/me/marketplaces') return json({ marketplaces: [] });
    if (path === '/invitations') return json({ invitations: [] });
    if (path === '/me/capabilities') return json({ userId: 'user_seller', roles: [], isAdmin: false });
    if (path === '/me/onboarding') return json({ onboarding_completed: true, onboarding_version: 1, first_proof_coaching_completed: true, onboarding_enrolled: false, current_version: 1 });
    if (path === `/proofs/${summary.proofId}`) return detail();
    return json({ error: { code: 'UNAVAILABLE', message: 'Optional fixture feature unavailable' } }, 404);
  }));
}
it('continues the existing authorized incomplete Proof without creating another root', async () => {
  const detail = vi.fn(async () => json(ready)); mockApi(detail); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record packing' }));
  await waitFor(() => expect(window.location.pathname).toBe(`/proofs/${summary.proofId}/capture`));
  expect(detail).toHaveBeenCalled();
});
it('revalidates a wide-screen next task and opens a newly finalized record instead of capture', async () => {
  mockApi(async () => json({ ...ready, status: 'FINALIZED', finalizedAt: '2026-10-11T00:00:00Z' })); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record packing' }));
  await waitFor(() => expect(window.location.pathname).toBe(`/proofs/${summary.proofId}`));
  expect(window.location.pathname.endsWith('/capture')).toBe(false);
});
it('routes failed upload recovery to the desktop upload screen rather than its notifications page', async () => {
  queue.list.mockResolvedValue([{ key: 'saved', proofId: summary.proofId, kind: 'station', file: new Blob(['fixture'], { type: 'video/webm' }), available: true, accepted: true, committed: false, finalized: false, preserved: false, retryStopped: true }]);
  mockApi(async () => json(ready)); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resolve upload' }));
  await waitFor(() => expect(window.location.pathname).toBe('/uploads'));
});
it('discards a late recommended-task response after sign-out', async () => {
  let finish!: (value: Response) => void;
  const detail = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  mockApi(detail); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record packing' }));
  await waitFor(() => expect(detail).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  finish(json(ready));
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  expect(screen.queryByRole('button', { name: 'Record packing' })).not.toBeInTheDocument();
});
it('keeps a failed fresh authorization check on Home without opening the old camera target', async () => {
  mockApi(async () => json({ error: { code: 'PARTICIPANT_NOT_AUTHORIZED', message: 'Unavailable' } }, 403)); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record packing' }));
  expect(await screen.findByText('This Proof is not available.')).toBeInTheDocument();
  expect(window.location.pathname.endsWith('/capture')).toBe(false);
});
it('does not open a late camera task while sign-out checks saved local work', async () => {
  let finishDetail!: (value: Response) => void;
  let finishLocalCheck!: (value: LocalRecordingSummary[]) => void;
  const detail = vi.fn(() => new Promise<Response>(resolve => { finishDetail = resolve; }));
  mockApi(detail); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Record packing' }));
  await waitFor(() => expect(detail).toHaveBeenCalledOnce());
  queue.list.mockImplementation(() => new Promise(resolve => { finishLocalCheck = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  finishDetail(json(ready));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Record packing' })).toBeEnabled());
  expect(window.location.pathname).toBe('/app');
  finishLocalCheck([]);
  await waitFor(() => expect(window.location.pathname).toBe('/'));
});

it('wide-screen Home and browser Back cannot abandon a live take; finishing unlocks navigation', async()=>{
  mockApi(async()=>json(ready));render(<App/>);
  fireEvent.click(await screen.findByRole('button',{name:'Record packing'}));
  fireEvent.click(await screen.findByRole('button',{name:'Start test take'}));
  const path=window.location.pathname;
  fireEvent.click(screen.getByRole('link',{name:'Home'}));
  expect(window.location.pathname).toBe(path);
  expect(screen.getByRole('status')).toHaveTextContent(/Finish recording/);
  window.history.replaceState({},'', '/app');fireEvent.popState(window);
  expect(window.location.pathname).toBe(path);
  fireEvent.click(screen.getByRole('button',{name:'Finish test take'}));
  fireEvent.click(screen.getByRole('link',{name:'Home'}));
  await waitFor(()=>expect(window.location.pathname).toBe('/app'));
});
