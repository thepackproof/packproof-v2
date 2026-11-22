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
  error?: string;
  onDisconnect: () => void;
  onReviewFiles: () => void;
}

export function FacilityRecoveryReview({ installation, workspace, environment, locations, busy, disconnected,
  error, onDisconnect, onReviewFiles }: FacilityRecoveryReviewProps) {
  const [consent, setConsent] = useState(false);
  const revoked = disconnected || installation.state === 'revoked';
  const needsFacility = installation.locationId === null;
  const missingDestinations = needsFacility && !revoked && !locations?.length;
  const fileDeadline = configurationReviewDeadline(installation.pendingProposal?.sourceContract);
  const fileExpired = fileDeadline !== null && Date.now() > fileDeadline;
  const originalName = installation.pendingProposal?.sourceContract?.historyPolicy?.initialFileName;
  const fileOption = installation.pendingProposal && <section>
    <h2>{fileExpired ? 'Renew your export file review' : 'Review the export file'}</h2>
    {fileExpired ? <p>The review for <strong>{originalName || 'the selected export file'}</strong> expired. Keep this computer connected. In the updated PackProof Windows app, select <strong>Request a fresh file review</strong> and follow the prompts to review the new request.</p>
      : <p>You can review the pending export file using this computer’s current connection.</p>}
    <button type="button" className="records-button secondary" disabled={busy} onClick={onReviewFiles}>View the separate file configuration review</button>
  </section>;
  return <section className="records-panel agent-approval" aria-label="Facility connection">
    <header className="records-page-heading"><div>
      <h1>{revoked ? 'Continue in PackProof on Windows' : missingDestinations ? 'Finish setting up this computer' : needsFacility ? 'Reconnect this computer to a facility' : 'Review this computer’s facility connection'}</h1>
      <p>{installation.deviceName} · {workspace} · {environment === 'live' ? 'Production' : 'Sandbox'}</p>
    </div></header>
    {missingDestinations && fileOption}
    {revoked ? <>
      <p role="status">The previous connection is disconnected. Finish reconnecting on this computer.</p>
      <ol>
        <li>In PackProof on Windows, select <strong>Check connection again</strong>.</li>
        <li>Check the box to preserve pending work, then select <strong>Preserve work and reconnect</strong>.</li>
        <li>Select <strong>Connect this computer to a facility</strong>. Match its code in the browser, choose your authorized facility under <strong>Approved location</strong>, and approve setup.</li>
      </ol>
    </> : needsFacility && !locations?.length ? <>
      <h2>Make your facility available</h2>
      <p>{locations ? 'This workspace lists no facilities available to this account.' : 'PackProof could not confirm which facilities are available to this account.'} Your current connection is still in place.</p>
      <p>Ask your PackProof administrator to arrange access to the intended facility, then reload this page to check again.</p>
    </> : needsFacility && locations ? <>
      <p>This computer’s current connection has no facility. Disconnect it here, then choose its facility when you reconnect in PackProof on Windows.</p>
      <p>Before disconnecting, check that the facility you intend to use is listed here.</p>
      <ul aria-label="Available facilities">{locations.map(site => <li key={site.id}>{site.name}</li>)}</ul>
      <p>Disconnecting stops this installation’s service access. Pending work can be preserved when you reconnect. Previously accepted records stay in PackProof.</p>
      <label className="agent-check"><input type="checkbox" checked={consent} disabled={busy}
        onChange={event => setConsent(event.target.checked)}/>Disconnect the current service access for {installation.deviceName}.</label>
      <button type="button" className="records-button" disabled={!consent || busy}
        onClick={() => { if (consent && !busy) onDisconnect(); }}>{busy ? 'Disconnecting…' : 'Disconnect and continue'}</button>
    </> : <p>{installation.locationId ? 'This installation already has an assigned facility.' : 'The facility assignment could not be confirmed.'} Return to PackProof on Windows and select <strong>Check connection again</strong>.</p>}
    {error && <p role="alert" className="records-error-text">{error}</p>}
    {!missingDestinations && fileOption}
  </section>;
}
