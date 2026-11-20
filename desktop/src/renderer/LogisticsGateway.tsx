import { useCallback, useEffect, useState } from 'react';
import type { PackProofDesktop } from '../shared/contracts';
import './logistics-gateway.css';

type Bridge = NonNullable<PackProofDesktop['workspace']>;
type Choices = { orders: boolean; setup: boolean };

/**
 * Unified Windows entry point. This is a functional route to the existing
 * authorized Logistics host, not a second copy of the facility setup UI.
 * Design authority: Figma PZ8dfCcXe2D8SMtmF497v3, 2:9 and 69:8866.
 */
export function LogisticsGateway({ bridge, onCommerce }: { bridge: Bridge; onCommerce: () => void }) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const result = await bridge.choices();
      setChoices(result);
    } catch (reason) {
      setChoices(null);
      setError(reason instanceof Error ? reason.message : 'Could not verify Logistics access. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  }, [bridge]);
  useEffect(() => { void refresh(); }, [refresh]);

  const open = async (destination: 'orders' | 'setup') => {
    if (busy || checking || !choices?.[destination]) return;
    setBusy(true);
    setError('');
    try {
      await bridge[destination]();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open Logistics. Try again or check this workstation.');
    } finally {
      setBusy(false);
    }
  };
  const primary: 'orders' | 'setup' = choices?.orders ? 'orders' : 'setup';
  const primaryLabel = primary === 'orders' ? 'Open my orders' : 'Connect my records';

  return <main className="logistics-entry" data-design-file="PZ8dfCcXe2D8SMtmF497v3" data-design-node="2:9">
    <header className="logistics-entry-header">
      <div className="logistics-entry-brand" aria-label="PackProof Connect"><img src="/brand/connect/packproof.png" width={40} height={46} alt=""/><strong>PackProof</strong></div>
      <span className="logistics-entry-product">CONNECT</span>
      <button className="logistics-entry-secondary" onClick={onCommerce}>Open Commerce workspace</button>
    </header>
    <div className="logistics-entry-content">
      <section className="logistics-entry-intro" aria-labelledby="logistics-entry-title">
        <span className="logistics-entry-accent" aria-hidden="true" />
        <span className="logistics-entry-eyebrow">PACKPROOF LOGISTICS</span>
        <h1 id="logistics-entry-title">Your orders.<br/>One clear story.</h1>
        <p>Bring the order, packing list, and shipment together. Start with the records your team already uses. We’ll show you one matched order before you turn on updates.</p>
        {error && <div className="logistics-entry-error" role="alert"><strong>Logistics needs attention</strong><p>{error}</p><button onClick={() => void refresh()} disabled={checking}>Check access again</button></div>}
        <div className="logistics-entry-actions">
          <button className="logistics-entry-primary" disabled={checking || busy || !choices?.[primary]} onClick={() => void open(primary)}>{checking ? 'Checking this workstation…' : busy ? 'Opening…' : primaryLabel}<span aria-hidden="true">→</span></button>
          {choices?.setup && choices.orders && <button className="logistics-entry-secondary" disabled={busy} onClick={() => void open('setup')}>Facility setup</button>}
        </div>
        {checking && <p className="logistics-entry-state" role="status">Checking your account and facility access…</p>}
        {!checking && !error && choices && !choices.orders && !choices.setup && <p className="logistics-entry-state" role="status">This account does not have an available Logistics action. Ask a facility administrator to review access.</p>}
        <p className="logistics-entry-footnote">No technical experience needed. Your existing source records are never modified by opening this workspace.</p>
      </section>
      <section className="logistics-entry-explainer" aria-label="Fictional example order timeline">
        <span className="logistics-entry-pill">ORDER PREVIEW · EXAMPLE</span>
        <h2>Order #10482</h2>
        <p>North Ridge Supply · Illustrative record, not connected to your account</p>
        <span className="logistics-entry-status">In transit · 3 of 4 stages</span>
        <ol className="logistics-entry-steps">
          <li><span className="logistics-entry-step-icon order"><img src="/brand/connect/order.svg" width={34} height={34} alt="" aria-hidden="true"/></span><div><strong>Order placed</strong><small>Customer order, 3 items</small></div></li>
          <li><span className="logistics-entry-step-icon packing"><img src="/brand/connect/packing.svg" width={34} height={34} alt="" aria-hidden="true"/></span><div><strong>Packed and checked</strong><small>Packing list and 2 photos</small></div></li>
          <li><span className="logistics-entry-step-icon shipping"><img src="/brand/connect/shipping.svg" width={34} height={34} alt="" aria-hidden="true"/></span><div><strong>Handed to carrier</strong><small>Tracking and shipment record</small></div></li>
          <li><span className="logistics-entry-step-icon delivery"><img src="/brand/connect/pendingDelivery.svg" width={34} height={34} alt="" aria-hidden="true"/></span><div><strong>Awaiting delivery</strong><small>Waiting for the carrier’s confirmation</small></div></li>
        </ol>
        <div className="logistics-entry-result">Next update: delivery confirmation</div>
      </section>
    </div>
  </main>;
}
