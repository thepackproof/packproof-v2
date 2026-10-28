import type { ProofSearchQuery, ProofSearchState } from '../../../packages/evidence-contracts/api-dashboard';
import type { ProofListView } from '../proof-list-state';

const states: readonly ProofSearchState[] = ['AWAITING_CAPTURE', 'IN_PROGRESS', 'READY', 'NEEDS_ATTENTION'];
const viewStates: Partial<Record<ProofListView, ProofSearchState>> = {
  attention: 'NEEDS_ATTENTION', progress: 'IN_PROGRESS', completed: 'READY',
};
const stateViews: Partial<Record<ProofSearchState, ProofListView>> = {
  NEEDS_ATTENTION: 'attention', IN_PROGRESS: 'progress', READY: 'completed',
};

function boundedText(value: string | null | undefined): string | undefined {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  return value.trim().slice(0, 200) || undefined;
}

function utcDate(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return undefined;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : undefined;
}

/** History entries own search filters. Cursors and credentials never become URL state. */
export function readDashboardFilters(
  search: string | URLSearchParams,
  fallback: { view?: ProofListView; query?: string } = {},
): ProofSearchQuery {
  const parameters = typeof search === 'string' ? new URLSearchParams(search) : search;
  const explicitState = parameters.get('state');
  const view = parameters.get('filter');
  const state = states.includes(explicitState as ProofSearchState)
    ? explicitState as ProofSearchState
    : viewStates[(view || fallback.view || 'all') as ProofListView];
  let from = utcDate(parameters.get('from'));
  let through = utcDate(parameters.get('through'));
  // Malformed address-bar dates never produce a rejected API request. The form
  // retains its own validation before committing a date range.
  if (from && through && from > through) { from = undefined; through = undefined; }
  return {
    q: boundedText(parameters.has('q') ? parameters.get('q') : fallback.query),
    state, from, through,
    connectionId: boundedText(parameters.get('connectionId')),
    integrationAccountId: boundedText(parameters.get('integrationAccountId')),
    limit: 50,
  };
}

/** Reuse existing list aliases so Home links and browser history stay meaningful. */
export function dashboardHref(filters: ProofSearchQuery): string {
  const parameters = new URLSearchParams();
  const state = states.includes(filters.state as ProofSearchState) ? filters.state : undefined;
  parameters.set('filter', state ? stateViews[state] || 'all' : 'all');
  if (state === 'AWAITING_CAPTURE') parameters.set('state', state);
  const q = boundedText(filters.q);
  if (q) parameters.set('q', q);
  const from = utcDate(filters.from ?? null), through = utcDate(filters.through ?? null);
  if (!from || !through || from <= through) {
    if (from) parameters.set('from', from);
    if (through) parameters.set('through', through);
  }
  const connectionId = boundedText(filters.connectionId);
  const integrationAccountId = boundedText(filters.integrationAccountId);
  if (connectionId) parameters.set('connectionId', connectionId);
  if (integrationAccountId) parameters.set('integrationAccountId', integrationAccountId);
  return `/proofs?${parameters}`;
}
