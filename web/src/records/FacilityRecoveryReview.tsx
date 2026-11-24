import { useState } from 'react';
import type { AgentInstallation } from './AgentConnections';
import { configurationReviewDeadline } from './ConfigurationApproval';

interface FacilityRecoveryReviewProps {
  installation: AgentInstallation;
  workspace: string;
  environment: string;
  locations?: ReadonlyArray<{ id: string; name: string }>;
  busy: boolean;
  disconnected: boolean;
  connected?: boolean;
  error?: string;
  onRefresh: () => void;
  onDisconnect: () => void;
  onReviewFiles: () => void;
}

export function FacilityRecoveryReview({ installation, workspace, environment, locations, busy, disconnected,
  connected, error, onRefresh, onDisconnect, onReviewFiles }: FacilityRecoveryReviewProps) {
  const [consent, setConsent] = useState(false);
  const revoked = disconnected || installation.state === 'revoked';
  const needsFacility = installation.locationId === null;
  const activationPending = !!installation.locationId && !revoked && installation.capabilities?.guidedFacilitySetup !== true;
  const missingDestinations = needsFacility && !revoked && !locations?.length;
  const fileDeadline = configurationReviewDeadline(installation.pendingProposal?.sourceContract);
  const fileExpired = fileDeadline !== null && Date.now() > fileDeadline;
  const originalName = installation.pendingProposal?.sourceContract?.historyPolicy?.initialFileName;
  const fileOption = installation.pendingProposal && <section>
    <h2>{fileExpired ? 'Renew your export file review' : 'Review the export file'}</h2>
    {fileExpired ? <p>The review for <strong>{originalName || 'the selected export file'}</strong> expired. Keep this computer connected. Request a fresh file review from the source computer.</p>
      : <p>You can review the pending export file using this computer’s current connection.</p>}
    <button type="button" className="records-button secondary" disabled={busy} onClick={onReviewFiles}>View the separate file configuration review</button>
  </section>;
  return <section className="records-panel agent-approval" aria-label="Facility connection">
    <header className="records-page-heading"><div>
      <h1>{revoked ? 'Service access revoked' : activationPending ? 'Setup activation is pending' : connected ? 'This computer is connected' : missingDestinations ? 'Finish setting up this computer' : needsFacility ? 'Reconnect this computer to a facility' : 'Review this computer’s facility connection'}</h1>
      <p>{installation.deviceName} · {workspace} · {environment === 'live' ? 'Production' : 'Sandbox'}</p>
    </div></header>
    {missingDestinations && fileOption}
    {revoked ? <>
      <p role="status">The previous connection is disconnected. To reconnect, preserve pending work on the source computer and request a new enrollment.</p>
      <p>Match the new enrollment code in the browser, choose the approved facility, and confirm setup.</p>
    </> : needsFacility && !locations?.length ? <>
      <h2>Make your facility available</h2>
      <p>{locations ? 'This workspace lists no facilities available to this account.' : 'PackProof could not confirm which facilities are available to this account.'} Your current connection is still in place.</p>
      <p>Ask your PackProof administrator to arrange access to the intended facility, then reload this page to check again.</p>
    </> : needsFacility && locations ? <>
      <p>This computer’s current connection has no facility. Disconnect it here, then choose its facility during enrollment.</p>
      <p>Before disconnecting, check that the facility you intend to use is listed here.</p>
      <ul aria-label="Available facilities">{locations.map(site => <li key={site.id}>{site.name}</li>)}</ul>
      <p>Disconnecting stops this installation’s service access. Pending work can be preserved when you reconnect. Previously accepted records stay in PackProof.</p>
      <label className="agent-check"><input type="checkbox" checked={consent} disabled={busy}
        onChange={event => setConsent(event.target.checked)}/>Disconnect the current service access for {installation.deviceName}.</label>
      <button type="button" className="records-button" disabled={!consent || busy}
        onClick={() => { if (consent && !busy) onDisconnect(); }}>{busy ? 'Disconnecting…' : 'Disconnect and continue'}</button>
    </> : activationPending ? <>
      <p role="status">{installation.capabilities?.guidedFacilitySetup === false
        ? 'This computer is connected to its facility, but guided setup is not enabled for it yet.'
        : 'The facility connection is saved, but guided setup availability has not been confirmed.'}</p>
      <p>PackProof must confirm guided setup is enabled for this facility before source discovery is available. Keep the current connection.</p>
      <p>This page checks for activation automatically.</p>
      <div className="records-actions">
        <button type="button" className="records-button secondary" disabled={busy} onClick={onRefresh}>Check setup status</button>
        <a className="records-button secondary" href="mailto:admin@thepackproof.com?subject=PackProof%20facility%20setup%20activation">Contact PackProof support</a>
      </div>
    </> : <p role="status">{installation.locationId ? 'This computer is connected to its facility.' : 'The facility assignment could not be confirmed.'}</p>}
    {connected && !revoked && <p>Connecting the facility has not uploaded any files or started collection.</p>}
    {error && <p role="alert" className="records-error-text">{error}</p>}
    {!missingDestinations && fileOption}
  </section>;
}
