import { useId, type RefObject } from 'react';
import type { AgentInstallation } from './AgentConnections';

interface FacilityConnectionHelpProps {
  installation: Pick<AgentInstallation, 'state' | 'locationId'>;
  hasAvailableFacilities: boolean;
  reviewRef: RefObject<HTMLDetailsElement | null>;
}

export function FacilityConnectionHelp({ installation, reviewRef, hasAvailableFacilities }: FacilityConnectionHelpProps) {
  const headingId = useId();
  const revoked = installation.state === 'revoked';
  if (installation.locationId !== null || (installation.state !== 'setup' && !revoked)) return null;

  function reviewServiceAccess() {
    const details = reviewRef.current;
    if (!details) return;
    details.open = true;
    details.querySelector('summary')?.focus();
  }

  return (
    <section className="records-notice neutral" aria-labelledby={headingId}>
      <div>
        <h3 id={headingId}>{revoked ? 'Reconnect this computer to a facility' : 'This computer has no assigned facility'}</h3>
        {!revoked && !hasAvailableFacilities ? <p>Keep the current connection while a workspace administrator confirms your account can select its intended facility. Reload this page after the facility is available.</p> : <>
        {!revoked && <>
          <p>To use this computer with PackProof Logistics, replace its current approval and choose a facility. Revoking the approval stops service access for this installation.</p>
          <button type="button" className="records-button secondary" onClick={reviewServiceAccess}>Review service access</button>
        </>}
        <p>{revoked ? 'Service access has been revoked.' : 'After revoking access, keep any pending work on the source computer.'}</p>
        <ol>
          <li>Preserve pending work before requesting a new enrollment from the same computer.</li>
          <li>Match the new enrollment code in the browser, choose the approved facility, and confirm setup.</li>
        </ol>
        </>}
      </div>
    </section>
  );
}
