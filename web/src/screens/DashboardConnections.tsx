import { useEffect, useId, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { CommerceConnectionView } from '../api/types';
import type { ConnectionHealthView } from '../api/connection-health';
import './dashboard-connections.css';

export interface DashboardConnectionsProps {
  api: Pick<PackProofApi, 'getCommerceConnectionHealth'>;
  connections: CommerceConnectionView[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenConnections: () => void;
}

function time(value: string | null | undefined): string {
  if (!value) return 'Not confirmed';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not confirmed' : date.toLocaleString();
}

function authorization(status: string): string {
  if (status === 'ACTIVE') return 'Authorized';
  if (['EXPIRED', 'REVOKED', 'DISCONNECTED', 'REAUTH_REQUIRED'].includes(status)) return 'Reconnect required';
  if (status === 'PENDING') return 'Connection pending';
  return 'Review connection';
}

const nextSteps: Record<ConnectionHealthView['nextAction'], string> = {
  RECONNECT: 'Reconnect this store in Integrations to resume order checks.',
  NO_ORDER_IMPORT: 'This connection does not support order import. Review your integrations or create a Proof directly.',
  CONTACT_SUPPORT: 'This connection needs a PackProof review. Open Integrations for details and support.',
  RETRY_SYNC: 'The last order check needs another attempt. Open Integrations to retry it.',
  ENABLE_AUTOMATION: 'Automatic order checks are paused. Open Integrations to enable them when you are ready.',
  WAIT: 'PackProof is checking for source updates. Check back after the current check finishes.',
  NONE: 'No connection action is required in this health report.',
};

/** Read-only overview. Detailed health is requested for one explicitly opened
 * connection, never for every account in the list. Mutating actions remain on
 * the existing Integrations screen with its ordinary authorization and prompts. */
export function DashboardConnections({ api, connections, loading = false, error = null, onRetry, onOpenConnections }: DashboardConnectionsProps) {
  const selectId = useId();
  const detailId = useId();
  const [selectedId, setSelectedId] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ api: DashboardConnectionsProps['api']; value: ConnectionHealthView } | null>(null);
  const [checking, setChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const selected = connections.find(connection => connection.connectionId === selectedId) ?? connections[0];
  const currentId = selected?.connectionId;
  const expanded = Boolean(currentId && expandedId === currentId);

  useEffect(() => {
    const request = ++generation.current;
    setHealth(null);
    setHealthError(null);
    setChecking(false);
    if (!expanded || !currentId || loading || error) return;
    let cancelled = false;
    setChecking(true);
    void api.getCommerceConnectionHealth(currentId).then(value => {
      if (cancelled || generation.current !== request) return;
      if (value.connectionId !== currentId) throw new Error('Connection health could not be confirmed. Please try again.');
      setHealth({ api, value });
    }).catch(() => {
      if (!cancelled && generation.current === request) setHealthError('We could not check this connection. Try again or open Integrations.');
    }).finally(() => {
      if (!cancelled && generation.current === request) setChecking(false);
    });
    return () => { cancelled = true; };
  }, [api, currentId, expanded, refresh, loading, error]);

  const currentHealth = expanded && health?.api === api && health.value.connectionId === currentId ? health.value : null;
  const selectConnection = (id: string) => {
    generation.current++;
    setSelectedId(id);
    setExpandedId(null);
    setHealth(null);
    setHealthError(null);
  };

  return <section className="dashboard-connections workstation-panel" aria-labelledby={`${selectId}-heading`} data-dashboard-tour="connections">
    <header className="dashboard-connections-heading">
      <div><h2 id={`${selectId}-heading`}>Store connections</h2><p>Check where your orders come from and what needs attention.</p></div>
      <button type="button" className="text-link" onClick={onOpenConnections}>Manage connections</button>
    </header>
    {loading ? <p className="dashboard-connections-message" role="status">Loading your connections…</p> : error ? <div className="dashboard-connections-message" role="alert">
      <p>We could not load your connections. Your Proof search is still available.</p>
      {onRetry && <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry connections</button>}
    </div> : !selected ? <div className="dashboard-connections-empty">
      <strong>Bring your orders into PackProof</strong>
      <p>Connect a supported store in Integrations, or use New Proof to record a shipment directly.</p>
      <button type="button" className="btn btn-secondary" onClick={onOpenConnections}>Connect a store</button>
    </div> : <div className="dashboard-connections-body">
      <label htmlFor={selectId}>Connection <span className="dashboard-connections-count">{connections.length.toLocaleString()} linked</span></label>
      <select id={selectId} value={currentId} onChange={event => selectConnection(event.target.value)}>
        {connections.map(connection => <option key={connection.connectionId} value={connection.connectionId}>{connection.providerDisplay || connection.provider} · {connection.externalAccountReference || connection.connectionId}</option>)}
      </select>
      <div className="dashboard-connections-summary">
        <span className={`dashboard-connection-status${selected.status === 'ACTIVE' ? ' is-authorized' : ''}`}>{authorization(selected.status)}</span>
        <span>Last sync: {time(selected.lastSyncAt)}</span>
      </div>
      <button type="button" className="text-link dashboard-connections-disclosure" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpandedId(expanded ? null : currentId!)}>{expanded ? 'Hide connection health' : 'Show connection health'}</button>
      {expanded && <div id={detailId} className="dashboard-connections-detail" aria-busy={checking}>
        {checking && <p role="status">Checking this connection…</p>}
        {healthError && <div role="alert"><p>{healthError}</p><button type="button" className="btn btn-secondary" onClick={() => setRefresh(value => value + 1)}>Retry health check</button></div>}
        {currentHealth && <>
          <div className="dashboard-connections-report-heading">
            <strong>{authorization(currentHealth.status)}</strong>
            <span>Automatic checks {currentHealth.automation.paused ? 'paused' : 'enabled'}</span>
          </div>
          <dl className="dashboard-connections-facts">
            <div><dt>Last successful source check</dt><dd>{time(currentHealth.sync.sourceWatermarkAt)}{currentHealth.sync.stale === true && <span className="dashboard-connections-warning">Check is overdue</span>}</dd></div>
            <div><dt>Order import</dt><dd>{currentHealth.capabilities.incrementalListSupported ? 'Supported' : 'Not available for this connection'}</dd></div>
            <div><dt>Waiting source updates</dt><dd>{currentHealth.sync.pendingProviderEvents.toLocaleString()} provider notifications{currentHealth.sync.pageResumePending ? ' · More source pages are waiting' : ''}</dd></div>
          </dl>
          <div className="dashboard-connections-coverage">
            <h3>Discovered order coverage</h3>
            <dl>
              <div><dt>Discovered</dt><dd>{currentHealth.coverage.discovered.toLocaleString()}</dd></div>
              <div><dt>Eligible</dt><dd>{currentHealth.coverage.eligible.toLocaleString()}</dd></div>
              <div><dt>Excluded</dt><dd>{currentHealth.coverage.excluded.toLocaleString()}</dd></div>
              <div><dt>Awaiting a Proof</dt><dd>{currentHealth.coverage.eligibleWithoutProof.toLocaleString()}</dd></div>
              <div><dt>Awaiting capture</dt><dd>{currentHealth.coverage.awaitingCapture.toLocaleString()}</dd></div>
              <div><dt>In progress</dt><dd>{currentHealth.coverage.inProgress.toLocaleString()}</dd></div>
              <div><dt>Finalized</dt><dd>{currentHealth.coverage.finalized.toLocaleString()}</dd></div>
              {currentHealth.coverage.otherEligible > 0 && <div><dt>Other eligible</dt><dd>{currentHealth.coverage.otherEligible.toLocaleString()}</dd></div>}
            </dl>
            <p>These counts cover discovered source records. Finalized does not confirm preservation readiness; check the Ready status in your Proofs.</p>
          </div>
          {currentHealth.coverage.reviewOrderCount > 0 && <p className="dashboard-connections-warning">{currentHealth.coverage.reviewOrderCount.toLocaleString()} excluded {currentHealth.coverage.reviewOrderCount === 1 ? 'order needs' : 'orders need'} shipment review in Integrations.</p>}
          <p className="dashboard-connections-next-step">{nextSteps[currentHealth.nextAction]}</p>
          <div className="dashboard-connections-footer"><small>Health checked {time(currentHealth.observedAt)}. Times use your local timezone.</small><button type="button" className="text-link" onClick={() => setRefresh(value => value + 1)}>Refresh health</button></div>
        </>}
        <button type="button" className="btn btn-secondary" onClick={onOpenConnections}>Open Integrations</button>
      </div>}
    </div>}
  </section>;
}
