import { useId, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { CanonicalProof } from '../api/types';
import { Glyph } from '../site/Brand';
import { trackingConnectionLabel, TRACKING_CARRIERS } from '../../../mobile/src/copy/tracking-connection';

export function TrackingIntake({ api, proof, onSaved }: { api: PackProofApi; proof: CanonicalProof; onSaved?: () => void }) {
  const shipping = proof.shipmentObservations?.identity ?? proof.transaction.shipping;
  const groupId = useId();
  const [open, setOpen] = useState(false), [value, setValue] = useState(shipping?.trackingNumber ?? ''), [carrier, setCarrier] = useState(shipping?.carrier?.toLowerCase() ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const registered = proof.captureShipping?.registration.state === 'REGISTERED' || proof.shipmentSync?.status === 'READY';
  const connection = trackingConnectionLabel({ hasNumber: Boolean(shipping?.trackingNumber), registered, hasEvents: Boolean(proof.shipmentObservations?.events.length), errorCode: proof.captureShipping?.registration.errorCode });
  return <div className="stack">
    <p className="meta tracking-connection" role="status">{connection}</p>
    {!open && <button className="btn btn-secondary" onClick={() => setOpen(true)}>{shipping?.trackingNumber ? 'Connect or retry tracking' : 'Add tracking'}</button>}
    {open && <form className="record-tracking-form" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError(null);
      void api.featureRequest(proof.proofId, 'tracking', 'POST', { value, carrier }).then(() => {
        setOpen(false); setNotice('Tracking number saved.'); onSaved?.();
      }).catch(e => setError(e instanceof Error ? e.message : 'Tracking could not be connected. Try again.')).finally(() => setBusy(false));
    }}>
      <label>Tracking number or carrier link<input value={value} onChange={e => setValue(e.target.value)} maxLength={2048} required /></label>
      <fieldset className="carrier-fieldset"><legend>Carrier</legend><div className="carrier-options">
        {TRACKING_CARRIERS.map(([key, label]) => <label key={key} className="carrier-option">
          <input type="radio" name={groupId} value={key} checked={carrier === key} onChange={() => setCarrier(key)} />
          <span>{label}</span><span className="carrier-check" aria-hidden="true">{carrier === key && <Glyph name="check" size={16} />}</span>
        </label>)}
      </div><label className="carrier-automatic"><input type="radio" name={groupId} value="" checked={carrier === ''} onChange={() => setCarrier('')} />Detect automatically</label></fieldset>
      <p className="note">Added separately from the packing record. This does not change sealed evidence or mean the number was observed in the recording.</p>
      <button className="btn" disabled={busy || !value.trim()}>{busy ? 'Connecting…' : 'Save and connect tracking'}</button><button type="button" className="text-link" onClick={() => setOpen(false)}>Cancel</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
