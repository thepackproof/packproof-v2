import { useCallback, useEffect, useState } from 'react';
import type { PackProofDesktop } from '../shared/contracts';
import { Brand } from './components';
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
  const primaryLabel = primary === 'orders' ? 'Open my orders' : 'Set up this facility';

  return <main className="logistics-entry" data-design-file="PZ8dfCcXe2D8SMtmF497v3" data-design-node="2:9">
    <header className="logistics-entry-header">
      <Brand />
      <span className="logistics-entry-product">CONNECT</span>
      <button className="logistics-entry-secondary" onClick={onCommerce}>Open Commerce workspace</button>
    </header>
    <div className="logistics-entry-content">
      <section className="logistics-entry-intro" aria-labelledby="logistics-entry-title">
        <span className="logistics-entry-accent" aria-hidden="true" />
        <span className="logistics-entry-eyebrow">PACKPROOF LOGISTICS</span>
        <h1 id="logistics-entry-title">Your orders.<br/>One clear story.</h1>
        <p>Bring together the order, packing, shipping, and delivery records your team already creates. Every source stays connected to the same Proof.</p>
        {error && <div className="logistics-entry-error" role="alert"><strong>Logistics needs attention</strong><p>{error}</p><button onClick={() => void refresh()} disabled={checking}>Check access again</button></div>}
        <div className="logistics-entry-actions">
          <button className="logistics-entry-primary" disabled={checking || busy || !choices?.[primary]} onClick={() => void open(primary)}>{checking ? 'Checking this workstation…' : busy ? 'Opening…' : primaryLabel}<span aria-hidden="true">→</span></button>
          {choices?.setup && choices.orders && <button className="logistics-entry-secondary" disabled={busy} onClick={() => void open('setup')}>Facility setup</button>}
        </div>
        {checking && <p className="logistics-entry-state" role="status">Checking your account and facility access…</p>}
        {!checking && !error && choices && !choices.orders && !choices.setup && <p className="logistics-entry-state" role="status">This account does not have an available Logistics action. Ask a facility administrator to review access.</p>}
        <p className="logistics-entry-footnote">Existing source records are never modified by opening this workspace.</p>
      </section>
      <section className="logistics-entry-explainer" aria-label="How your Proof comes together">
        <span className="logistics-entry-pill">HOW IT WORKS</span>
        <h2>One order, across every system.</h2>
        <p>PackProof connects the evidence that already exists, from the first order to delivery.</p>
        <ol className="logistics-entry-steps">
          <li><span className="logistics-entry-step-icon order">1</span><div><strong>Order received</strong><small>Order system and line items</small></div></li>
          <li><span className="logistics-entry-step-icon packing">2</span><div><strong>Packed and verified</strong><small>Picking, scans, scales and photos</small></div></li>
          <li><span className="logistics-entry-step-icon shipping">3</span><div><strong>Handed to the carrier</strong><small>Labels, dispatch and tracking</small></div></li>
          <li><span className="logistics-entry-step-icon delivery">4</span><div><strong>Delivery recorded</strong><small>Arrival and exceptions</small></div></li>
        </ol>
        <div className="logistics-entry-result">Multiple sources. One evolving Proof.</div>
      </section>
    </div>
  </main>;
}
