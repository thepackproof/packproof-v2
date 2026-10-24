import type { ProofCollectionItem } from '../api/types';

/** Only attached sources are connected. A drawn line is never a custody claim. */
export function EvidenceSources({ proof, hasLocalRecording = false, confirmed = false }: {
  proof?: ProofCollectionItem;
  hasLocalRecording?: boolean;
  confirmed?: boolean;
}) {
  const sources = [
    proof?.transaction.externalReference ? { label: 'Order', detail: proof.transaction.externalReference, icon: '01' } : null,
    hasLocalRecording || confirmed || proof?.thumbnailDerivativeId ? { label: 'Evidence', detail: hasLocalRecording && !confirmed ? 'On this device' : confirmed ? 'Server confirmed' : 'Record available', icon: '02' } : null,
    proof?.transaction.trackingNumber ? { label: 'Shipment', detail: proof.transaction.carrier || 'Tracking attached', icon: '03' } : null,
  ].filter((source): source is { label: string; detail: string; icon: string } => source !== null);
  return <div className="eim-source-constellation" aria-label={sources.length ? 'Sources attached to this record' : 'Your evidence workspace'}>
    <div className="eim-source-heading"><span className="eim-source-mark" aria-hidden="true">P</span><span>{proof?.transaction.itemTitle || 'Evidence in motion'}<small>{proof ? 'Sources for this Proof' : 'One packing journey. One clear record.'}</small></span></div>
    {sources.length ? <ul>{sources.map(source => <li key={source.label}><span className="eim-source-number" aria-hidden="true">{source.icon}</span><span><strong>{source.label}</strong><small>{source.detail}</small></span></li>)}</ul> : <p className="eim-hero-empty">Start with your item. Add the packing recording, then keep the submitted evidence together.</p>}
  </div>;
}
