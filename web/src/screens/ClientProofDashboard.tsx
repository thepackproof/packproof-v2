import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { PackProofApi } from '../api/client';
import { ApiError, type CommerceConnectionView } from '../api/types';
import type { ProofSearchQuery, ProofSearchResult, ProofSearchState } from '../../../packages/evidence-contracts/api-dashboard';
import type { ProofListView } from '../proof-list-state';
import { Glyph } from '../site/Brand';
import { IconSearch } from '../components/Icons';
import { DashboardTour } from './dashboard-tour';
import { DashboardConnections } from './DashboardConnections';
import { DASHBOARD_STATES, dashboardAction, dashboardCsv, dashboardReason, dashboardStateLabel, dashboardTime } from './dashboard-presentation';
import './client-proof-dashboard.css';

export interface ClientProofDashboardProps {
  api: PackProofApi; accountKey?: string; initialQuery?: string; initialView?: ProofListView;
  initialFilters?: ProofSearchQuery; onFiltersChange?: (filters: ProofSearchQuery) => void;
  refreshVersion?: number; readyOrders?: ReactNode;
  onOpenProof: (proofId: string) => void; onCreate: () => void;
  onOpenConnections?: () => void; onOpenOrders?: () => void; onOpenUploads?: () => void; onOpenActivity?: () => void;
}
function initialFilters(props: ClientProofDashboardProps): ProofSearchQuery {
  const state = ({ attention: 'NEEDS_ATTENTION', completed: 'READY', progress: 'IN_PROGRESS' } as const)[props.initialView as 'attention' | 'completed' | 'progress'];
  return { q: props.initialQuery ?? '', state, ...props.initialFilters, limit: 50, after: undefined };
}
function keyOf(filters: ProofSearchQuery): string {
  return JSON.stringify([filters.q ?? '', filters.state ?? '', filters.from ?? '', filters.through ?? '', filters.connectionId ?? '', filters.integrationAccountId ?? '']);
}
function searchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session needs attention. Sign in again to check your Proofs.';
    if (error.status === 403) return 'Your current access does not allow this search. Refresh your session or contact your account owner.';
    if (error.status === 429) return 'PackProof is receiving too many requests. Wait a moment, then try again.';
    if (error.status === 400) return 'These filters could not be used. Clear the filters and try again.';
  }
  return 'We could not check your Proofs. Check your connection and try again.';
}
export function ClientProofDashboard(props: ClientProofDashboardProps) {
  return <DashboardWorkspace key={props.accountKey ?? 'current-session'} {...props} />;
}

function DashboardWorkspace(props: ClientProofDashboardProps) {
  const [filters, setFilters] = useState<ProofSearchQuery>(() => initialFilters(props));
  const [draft, setDraft] = useState(filters.q ?? '');
  const [storedResult, setResult] = useState<ProofSearchResult | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null), [pageError, setPageError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [connectionRefresh, setConnectionRefresh] = useState(0);
  const [connections, setConnections] = useState<CommerceConnectionView[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true), [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [offline, setOffline] = useState(navigator.onLine === false), [updatesAvailable, setUpdatesAvailable] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true), [compact, setCompact] = useState(false), [pages, setPages] = useState(1);
  const search = useRef<HTMLInputElement>(null), resultsHeading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0), mounted = useRef(true), resultOwner = useRef({ api: props.api, filters: keyOf(filters) });
  const activity = useRef({ loading, loadingMore, pages, offline, autoRefresh });
  activity.current = { loading, loadingMore, pages, offline, autoRefresh };
  const id = useId(), filterKey = keyOf(filters), incomingKey = keyOf(initialFilters(props));
  const result = resultOwner.current.api === props.api && resultOwner.current.filters === filterKey ? storedResult : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    const incoming = initialFilters(props);
    setFilters(previous => keyOf(previous) === keyOf(incoming) ? previous : incoming);
    setDraft(incoming.q ?? '');
    setDateError(null);
  }, [incomingKey]);
  useEffect(() => {
    let cancelled = false;
    setConnectionsLoading(true); setConnectionsError(null); setConnections([]);
    void props.api.listCommerceConnections().then(value => { if (!cancelled) setConnections(value.connections); })
      .catch(() => { if (!cancelled) setConnectionsError('Connections are unavailable.'); })
      .finally(() => { if (!cancelled) setConnectionsLoading(false); });
    return () => { cancelled = true; };
  }, [props.api, connectionRefresh]);
  useEffect(() => {
    const request = ++generation.current;
    const changed = resultOwner.current.api !== props.api || resultOwner.current.filters !== filterKey;
    resultOwner.current = { api: props.api, filters: filterKey };
    if (changed) { setResult(null); setPages(1); }
    setLoadingMore(false); setPageError(null); setError(null);
    if (navigator.onLine === false) { setLoading(false); setError('You are offline. Reconnect to check the latest Proof status.'); return; }
    setLoading(true);
    void props.api.searchProofs({ ...filters, after: undefined }).then(value => {
      if (!mounted.current || generation.current !== request) return;
      setResult(value); setPages(1); setUpdatesAvailable(false);
    }).catch(caught => {
      if (!mounted.current || generation.current !== request) return;
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) setResult(null);
      setError(searchError(caught));
    }).finally(() => { if (mounted.current && generation.current === request) setLoading(false); });
  }, [props.api, filterKey, refresh, props.refreshVersion]);
  useEffect(() => {
    const tick = () => {
      const state = activity.current;
      if (document.visibilityState !== 'visible' || state.offline || !state.autoRefresh || state.loading || state.loadingMore) return;
      if (state.pages > 1 || document.querySelector('[aria-modal="true"]')) setUpdatesAvailable(true);
      else setRefresh(value => value + 1);
    };
    const online = () => { setOffline(false); setRefresh(value => value + 1); setConnectionRefresh(value => value + 1); };
    const disconnected = () => setOffline(true);
    const updated = () => setUpdatesAvailable(true);
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault(); search.current?.focus();
      }
    };
    const timer = window.setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick); window.addEventListener('online', online); window.addEventListener('offline', disconnected);
    window.addEventListener('packproof:records-updated', updated); window.addEventListener('keydown', shortcut);
    return () => {
      window.clearInterval(timer); document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('online', online); window.removeEventListener('offline', disconnected);
      window.removeEventListener('packproof:records-updated', updated); window.removeEventListener('keydown', shortcut);
    };
  }, []);

  const apply = (next: ProofSearchQuery) => {
    setDateError(null);
    const normalized = { ...next, limit: 50, after: undefined };
    if (keyOf(normalized) === filterKey) { setRefresh(value => value + 1); return; }
    generation.current++; setFilters(normalized); setDraft(normalized.q ?? ''); setPages(1); props.onFiltersChange?.(normalized);
  };
  const change = (key: keyof ProofSearchQuery, value: string) => {
    const next = { ...filters, [key]: value || undefined };
    if (next.from && next.through && next.from > next.through) {
      setDateError('Choose a start date on or before the end date. Your previous date range is still applied.');
      return;
    }
    setDateError(null); apply(next);
  };
  const more = () => {
    if (!result?.nextCursor || loading || loadingMore || offline) return;
    const request = generation.current, cursor = result.nextCursor;
    setLoadingMore(true); setPageError(null);
    void props.api.searchProofs({ ...filters, after: cursor }).then(page => {
      if (!mounted.current || generation.current !== request) return;
      setResult(previous => previous ? { ...page, refreshedAt: previous.refreshedAt,
        proofs: [...new Map([...previous.proofs, ...page.proofs].map(row => [row.proofId, row])).values()] } : page);
      setPages(value => value + 1);
    }).catch(caught => {
      if (!mounted.current || generation.current !== request) return;
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) { setResult(null); setError(searchError(caught)); }
      else setPageError('We could not load more records. Your loaded records are still shown. Retry, or refresh to start from the latest page.');
    }).finally(() => { if (mounted.current && generation.current === request) setLoadingMore(false); });
  };
  const exportRows = () => {
    if (!result?.proofs.length || offline || error || loading) return;
    const url = URL.createObjectURL(new Blob([dashboardCsv(result.proofs)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'packproof-loaded-results.csv';
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rows = result?.proofs ?? [], filtered = Boolean(filters.q || filters.state || filters.from || filters.through || filters.connectionId || filters.integrationAccountId);
  const nextRows = [...rows].filter(row => row.readiness.state !== 'READY').sort((a, b) => {
    const rank = (state: ProofSearchState) => state === 'NEEDS_ATTENTION' ? 0 : state === 'AWAITING_CAPTURE' ? 1 : 2;
    return rank(a.readiness.state) - rank(b.readiness.state);
  }).slice(0, 3);
  const connectionLabel = (connection: CommerceConnectionView) => `${connection.providerDisplay || connection.provider} / ${connection.externalAccountReference || connection.connectionId}`;
  const navigate = (callback: (() => void) | undefined, path: string) => callback ? callback() : window.location.assign(path);

  return <main className={`page library-page workstation-proof-page client-dashboard${compact ? ' is-compact' : ''}`}>
    <a className="dashboard-skip-link" href={`#${id}-records`} onClick={() => resultsHeading.current?.focus()}>Skip to Proof results</a>
    <header className="workstation-page-heading dashboard-heading"><div><span className="workstation-eyebrow">Your evidence, together.</span><h1 className="page-title">Your Proofs</h1><p>Find a shipment, see what needs attention, and keep its evidence close.</p></div>
      <button type="button" className="btn" onClick={props.onCreate} data-dashboard-tour="create" data-onboarding="create capture"><Glyph name="plus" size={16} />New Proof</button></header>
    <DashboardTour accountKey={props.accountKey ?? 'current-session'} ready={!loading || Boolean(result) || Boolean(error)} />
    {offline && <div className="dashboard-banner is-warning" role="status"><strong>You are offline.</strong> Loaded records may be out of date. Reconnect before relying on their current status.</div>}
    <section className="dashboard-overview" aria-labelledby={`${id}-overview`} data-dashboard-tour="overview">
      <div className="dashboard-section-heading"><div><h2 id={`${id}-overview`}>At a glance</h2><p>{result ? `${rows.length.toLocaleString()} records loaded in this view${result.hasMore ? '; more records are available' : ''}.` : 'Your current view will appear here.'} Counts describe loaded results, not account totals.</p></div></div>
      <div className="dashboard-metrics">{DASHBOARD_STATES.map(state => <button type="button" key={state.value} data-onboarding={state.value === 'NEEDS_ATTENTION' ? 'attention' : state.value === 'READY' ? 'status' : undefined} aria-pressed={filters.state === state.value} onClick={() => apply({ ...filters, state: filters.state === state.value ? undefined : state.value })}>
        <span className={`dashboard-metric-icon state-${state.value.toLowerCase()}`}><Glyph name={state.icon} size={18} /></span><span>{state.label}</span><strong>{result ? rows.filter(row => row.readiness.state === state.value).length.toLocaleString() : '\u2014'}</strong><small>{state.description}</small>
      </button>)}</div>
    </section>
    <nav className="dashboard-shortcuts" aria-label="Workspace shortcuts">
      <button type="button" onClick={() => navigate(props.onOpenOrders, '/fulfillment')}><Glyph name="box" size={18} /><span>Order queue<small>Find shipments awaiting capture</small></span><Glyph name="arrow" size={15} /></button>
      <button type="button" onClick={() => navigate(props.onOpenUploads, '/uploads')}><Glyph name="film" size={18} /><span>Saved recordings<small>Review work kept on this device</small></span><Glyph name="arrow" size={15} /></button>
      <button type="button" onClick={() => navigate(props.onOpenActivity, '/activity')}><Glyph name="link" size={18} /><span>Invitations<small>Review requests to join a Proof</small></span><Glyph name="arrow" size={15} /></button>
    </nav>
    {props.readyOrders && <section className="dashboard-ready-orders" aria-label="Orders ready for recording">{props.readyOrders}</section>}
    <section className="workstation-panel dashboard-results" aria-labelledby={`${id}-records`} aria-busy={loading || loadingMore}>
      <div className="dashboard-section-heading" data-dashboard-tour="records" data-onboarding="proofs"><div><h2 id={`${id}-records`} tabIndex={-1} ref={resultsHeading}>Shipment records</h2><p>Newest created first. Open a Proof for playback, activity, sharing and its evidence package.</p></div><button type="button" className="text-link" onClick={exportRows} disabled={!rows.length || loading || offline || Boolean(error)}>Export loaded results</button></div>
      <form className="dashboard-search" role="search" data-dashboard-tour="search" onSubmit={event => { event.preventDefault(); apply({ ...filters, q: draft.trim() }); }}>
        <label htmlFor={`${id}-search`}>Order, tracking or Proof reference</label><div><span className="dashboard-search-input"><IconSearch /><input id={`${id}-search`} ref={search} value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} autoComplete="off" placeholder="Search item, order, tracking or Proof ID" /><kbd>Ctrl K</kbd></span><button type="submit" className="btn btn-secondary">Search</button></div>
      </form>
      <div className="dashboard-filters" data-dashboard-tour="filters">
        <label>Status<select value={filters.state ?? ''} onChange={event => change('state', event.target.value)}><option value="">All statuses</option>{DASHBOARD_STATES.map(state => <option key={state.value} value={state.value}>{state.label}</option>)}</select></label>
        <label>Created from (UTC)<input type="date" value={filters.from ?? ''} max={filters.through} onChange={event => change('from', event.target.value)} /></label>
        <label>Created through (UTC)<input type="date" value={filters.through ?? ''} min={filters.from} onChange={event => change('through', event.target.value)} /></label>
        <label>Store connection<select value={filters.connectionId ?? ''} onChange={event => change('connectionId', event.target.value)}><option value="">All connections</option>{filters.connectionId && !connections.some(item => item.connectionId === filters.connectionId) && <option value={filters.connectionId}>Selected connection</option>}{connections.map(connection => <option key={connection.connectionId} value={connection.connectionId}>{connectionLabel(connection)}</option>)}</select></label>
        <button className="text-link" type="button" onClick={() => { setDraft(''); apply({ limit: 50 }); }}>Clear filters</button>
      </div>
      {dateError && <p className="dashboard-banner is-warning" role="alert">{dateError}</p>}
      {filtered && <div className="dashboard-filter-chips" aria-label="Active filters">
        {filters.q && <button type="button" onClick={() => change('q', '')}>Search: {filters.q}<span aria-hidden="true"> x</span><span className="visually-hidden">; remove search filter</span></button>}
        {filters.state && <button type="button" onClick={() => change('state', '')}>{dashboardStateLabel(filters.state)}<span aria-hidden="true"> x</span><span className="visually-hidden">; remove status filter</span></button>}
        {filters.from && <button type="button" onClick={() => change('from', '')}>From {filters.from} UTC<span aria-hidden="true"> x</span><span className="visually-hidden">; remove start date</span></button>}
        {filters.through && <button type="button" onClick={() => change('through', '')}>Through {filters.through} UTC<span aria-hidden="true"> x</span><span className="visually-hidden">; remove end date</span></button>}
        {filters.connectionId && <button type="button" onClick={() => change('connectionId', '')}>Store selected<span aria-hidden="true"> x</span><span className="visually-hidden">; remove connection filter</span></button>}
        {filters.integrationAccountId && <button type="button" onClick={() => change('integrationAccountId', '')}>Integration account selected<span aria-hidden="true"> x</span><span className="visually-hidden">; remove integration account filter</span></button>}
      </div>}
      <div className="dashboard-results-toolbar"><div aria-live="polite">{loading && !result ? 'Loading Proofs...' : loading ? 'Refreshing Proofs...' : result ? 'Last updated ' + dashboardTime(result.refreshedAt) : 'Waiting for the server'}{(error || offline) && result && <strong> / Current status unconfirmed</strong>}</div>
        <div><label><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />Auto-refresh</label><button type="button" className="text-link" aria-pressed={compact} onClick={() => setCompact(value => !value)}>Compact rows</button><button type="button" className="text-link" disabled={loading || offline} onClick={() => setRefresh(value => value + 1)}>Refresh Proofs</button></div>
      </div>
      {updatesAvailable && <div className="dashboard-banner" role="status">Updates may be available. Refresh to show the latest first page; your filters will stay in place.</div>}
      {error && <div className="dashboard-banner is-warning" role="alert"><p>{error}{result ? ' Previously loaded results are shown below.' : ''}</p><button type="button" className="btn btn-secondary" disabled={loading || offline} onClick={() => setRefresh(value => value + 1)}>Try again</button>{filtered && <button type="button" className="text-link" onClick={() => apply({ limit: 50 })}>Reset search</button>}</div>}
      {loading && !result && <div className="dashboard-loading" role="status"><span className="dashboard-skeleton" /><span className="dashboard-skeleton" /><span className="dashboard-skeleton" /><span className="visually-hidden">Loading Proof records</span></div>}
      {!loading && !error && result && rows.length === 0 && <div className="dashboard-empty" role="status"><Glyph name="box" size={30} /><h3>{filtered ? 'No matching shipments' : 'Your first Proof starts here'}</h3><p>{filtered ? 'Try another order reference, adjust the dates or clear your filters.' : 'Record a shipment directly, or connect a supported store to bring in orders.'}</p><button type="button" className="btn" onClick={filtered ? () => apply({ limit: 50 }) : props.onCreate}>{filtered ? 'Show all Proofs' : 'Create your first Proof'}</button>{!filtered && <button type="button" className="text-link" onClick={() => navigate(props.onOpenConnections, '/stores')}>Connect a store</button>}</div>}
      {rows.length > 0 && <div className="dashboard-table-scroll"><table className="dashboard-proof-table"><caption>{rows.length} records loaded{result?.hasMore ? ' / more records available' : ''}. Ready includes confirmed preservation. Times below use your local timezone. CSV exports include only these loaded summaries.</caption>
        <thead><tr><th scope="col">Order / Proof</th><th scope="col">Item / shipment</th><th scope="col">Submitted by / received</th><th scope="col">Status</th><th scope="col">Next action</th></tr></thead><tbody>{rows.map(row => <tr key={row.proofId}>
          <th scope="row"><button type="button" className="text-link dashboard-record-link" onClick={() => props.onOpenProof(row.proofId)}>{row.externalId ?? row.proofId}</button>{row.externalId && <small className="dashboard-reference">{row.proofId}</small>}<small>Created {dashboardTime(row.createdAt)}</small>{row.provider && <small>{row.provider}</small>}</th>
          <td><strong>{row.itemTitle ?? 'Shipment'}</strong>{row.itemCount > 1 && <small>{row.itemCount} line items</small>}{row.trackingNumber && <small className="dashboard-reference">{row.trackingNumber}</small>}</td>
          <td>{row.recordedBy ?? 'Awaiting recording'}<small>{dashboardTime(row.serverReceivedAt)}</small></td>
          <td><span className={`dashboard-state state-${row.readiness.state.toLowerCase()}`}>{dashboardStateLabel(row.readiness.state)}</span><small>{dashboardReason(row)}</small></td>
          <td><button type="button" className="text-link" aria-label={`${dashboardAction(row)}: ${row.externalId ?? row.proofId}`} onClick={() => props.onOpenProof(row.proofId)}>{dashboardAction(row)} <span aria-hidden="true">&rarr;</span></button></td>
        </tr>)}</tbody></table></div>}
      {pageError && <div className="dashboard-banner is-warning" role="alert">{pageError}</div>}
      {result && rows.length > 0 && <footer className="dashboard-pagination"><span>{rows.length} loaded{result.hasMore ? ' / more available' : ' / end of results'}{pages > 1 ? ` / ${pages} pages` : ''}</span>{result.hasMore && <button type="button" className="btn btn-secondary" disabled={loading || loadingMore || offline} onClick={more}>{loadingMore ? 'Loading more...' : pageError ? 'Retry loading more' : 'Load more Proofs'}</button>}</footer>}
    </section>
    <div className="dashboard-bottom-grid"><section className="workstation-panel dashboard-next" aria-labelledby={`${id}-next`}><div className="dashboard-section-heading"><div><h2 id={`${id}-next`}>Next up in this view</h2><p>Suggested records from the results you have loaded.</p></div></div>
      {nextRows.length ? <ul>{nextRows.map(row => <li key={row.proofId}><span className={`dashboard-state state-${row.readiness.state.toLowerCase()}`}>{dashboardStateLabel(row.readiness.state)}</span><strong>{row.externalId ?? row.itemTitle ?? row.proofId}</strong><p>{dashboardReason(row)}</p><button type="button" className="text-link" onClick={() => props.onOpenProof(row.proofId)}>{dashboardAction(row)}<span className="visually-hidden"> {row.externalId ?? row.proofId}</span></button></li>)}</ul> : <div className="dashboard-next-empty"><Glyph name="check" size={22} /><p>{result ? 'No next steps among the records loaded in this view.' : 'Load your records to see suggested next steps.'}</p><button type="button" className="text-link" onClick={() => apply({ limit: 50, state: 'NEEDS_ATTENTION' })}>Check records needing attention</button></div>}
      {(error || offline) && rows.length > 0 && <p className="dashboard-footnote">These suggestions use previously loaded records. Reconnect and refresh to confirm them.</p>}
    </section><DashboardConnections api={props.api} connections={connections} loading={connectionsLoading} error={connectionsError} onRetry={() => setConnectionRefresh(value => value + 1)} onOpenConnections={() => navigate(props.onOpenConnections, '/stores')} /></div>
    <details className="dashboard-status-guide"><summary>What do these statuses mean?</summary><dl>{DASHBOARD_STATES.map(state => <div key={state.value}><dt>{state.label}</dt><dd>{state.description}</dd></div>)}</dl><p>Ready describes finalization and required preservation receipts. It does not decide a shipment dispute. Playback, sharing and exports follow your current access and retention policy. Automatic refresh runs every 30 seconds while this page is visible; after loading more pages, it asks you to refresh so your place stays stable.</p></details>
  </main>;
}
