import { useState } from 'react';
import type { AgentInstallation } from './AgentConnections';

export function FacilityConnectionForm({ installation, workspace, busy, error, onConnect, onReviewFiles }: {
  installation: AgentInstallation;
  workspace: string;
  busy: boolean;
  error?: string;
  onConnect: (choice: { locationId: string } | { facilityName: string }) => void;
  onReviewFiles: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const access = installation.facilityConnection!;
  const creating = access.canCreate && access.locations.length === 0;
  const selected = access.locations.find(site => site.id === locationId);
  const ready = consent && (creating ? !!name.trim() : !!selected);
  return <section className="records-panel agent-approval" aria-label="Facility connection">
    <header className="records-page-heading"><div>
      <span className="records-eyebrow">CONNECT YOUR COMPUTER</span>
      <h1>{creating ? 'Name your facility' : 'Choose this computer’s facility'}</h1>
      <p>{installation.deviceName} · {workspace}</p>
    </div></header>
    <p>{creating ? 'Create the first facility in your workspace so PackProof can keep its orders and source records together.'
      : 'Select where this computer will collect records. Your existing connection stays in place.'}</p>
    {creating ? <div className="agent-enrollment-fields"><label>Facility name
      <input maxLength={120} value={name} disabled={busy} placeholder="For example, Columbus warehouse"
        onChange={event => { setName(event.target.value); setConsent(false); }}/>
    </label></div> : access.locations.length ? <div className="agent-enrollment-fields"><label>Facility
      <select value={locationId} disabled={busy} onChange={event => { setLocationId(event.target.value); setConsent(false); }}>
        <option value="">Choose a facility</option>
        {access.locations.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}
      </select>
    </label></div> : <p role="status">No facility is available to this account. A workspace owner must create a facility or grant access to an existing one. Your current connection and saved files stay in place.</p>}
    {(creating || access.locations.length > 0) && <>
      <p>Connecting a facility does not upload files or start collection. You will review your sources in PackProof on Windows next. Any earlier file review will need to be recreated for this facility; the original file stays on your computer.</p>
      {(creating || selected && !selected.guidedSetupAvailable) && <p className="records-notice neutral">This facility also needs guided setup enabled by PackProof before source discovery is available. Saving its connection does not enable collection.</p>}
      <label className="agent-check"><input type="checkbox" checked={consent} disabled={busy || !(creating ? name.trim() : selected)}
        onChange={event => setConsent(event.target.checked)}/>
        Connect {installation.deviceName} to {creating ? name.trim() || 'the facility named above' : selected?.name || 'the selected facility'} and restart its unapproved source review.
      </label>
      <button type="button" className="records-button" disabled={busy || !ready} onClick={() => {
        if (busy || !ready) return;
        onConnect(creating ? { facilityName: name.trim() } : { locationId });
      }}>{busy ? 'Connecting…' : 'Connect this computer'}</button>
    </>}
    {error && <p role="alert" className="records-error-text">{error}</p>}
    {installation.pendingProposal && <details><summary>Saved report</summary>
      <p>The saved file review is separate from this computer’s facility connection.</p>
      <button type="button" className="records-button secondary" disabled={busy} onClick={onReviewFiles}>Review saved report separately</button>
    </details>}
  </section>;
}
