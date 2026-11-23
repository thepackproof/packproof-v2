import { useCallback, useEffect, useRef, useState } from 'react';
import type { PackProofDesktop } from '../shared/contracts';
import { FirstRunContent } from '../../../connect-windows/ui/experience/FirstRunContent';
import './logistics-gateway.css';

type Bridge = NonNullable<PackProofDesktop['workspace']>;
type Choices = { orders: boolean; setup: boolean };
const navigation = ['Overview', 'Orders & proofs', 'Connected systems', 'Match intelligence', 'Exceptions', 'Evidence integrity', 'Exports & destinations', 'Settings'];

/** The signed-in entry uses the approved Evidence OS first-run frame. All
 * workspace actions still pass through the human-session authorization owner. */
export function LogisticsGateway({ bridge, onCommerce }: { bridge: Bridge; onCommerce: () => void }) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setChecking(true);
    setError('');
    try {
      const result = await bridge.choices();
      if (current === request.current) setChoices(result);
    } catch (reason) {
      if (current !== request.current) return;
      setChoices(null);
      setError(reason instanceof Error ? reason.message : 'Could not verify your facility access. Check your connection and try again.');
    } finally {
      if (current === request.current) setChecking(false);
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
    const returned = () => { void refresh(); };
    window.addEventListener('focus', returned);
    return () => { request.current++; window.removeEventListener('focus', returned); };
  }, [refresh]);

  const open = async (destination: 'orders' | 'setup') => {
    if (busy || checking || !choices?.[destination]) return;
    setBusy(true);
    setError('');
    try { await bridge[destination](); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open your workspace. Check the connection and try again.'); }
    finally { setBusy(false); }
  };
  const primary: 'orders' | 'setup' = choices?.orders ? 'orders' : 'setup';
  const primaryLabel = checking ? 'Checking this workstation…' : busy ? 'Opening…' : primary === 'orders' ? 'Open my orders' : 'Discover my systems';
  const status = checking ? 'Checking your connection' : error ? 'Connection needs attention' : choices?.orders ? 'Workspace available' : 'Ready to connect';

  return <main className="logistics-entry" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="3:15">
    <aside className="logistics-entry-sidebar" aria-label="PackProof navigation">
      <div className="logistics-entry-brand"><span><img src="./brand/connect/evidence-os/brand.png" width={31} height={42} alt="" /></span><strong>PackProof</strong><small>Connect</small></div>
      <span className="logistics-entry-nav-label">Workspace</span>
      <nav aria-label="Workspace">
        {navigation.map((label, index) => {
          const destination = index < 2 ? 'orders' : index === 2 ? 'setup' : null;
          const available = !!destination && !!choices?.[destination];
          return <button type="button" key={label} aria-current={index === 2 ? 'page' : undefined}
            disabled={!available || checking || busy}
            title={destination ? available ? undefined : 'Complete your facility connection to open this view.' : 'Open your workspace to use this view.'}
            onClick={() => destination && void open(destination)}><span aria-hidden="true" />{label}</button>;
        })}
      </nav>
      <div className="logistics-entry-status" role="status">
        <div><img src="./brand/connect/evidence-os/activity-status.svg" width={22} height={22} alt="" /><strong>{status}</strong></div>
        <p>{choices?.orders ? 'Open your workspace for current activity.' : 'Collection begins after you approve your sources.'}</p>
      </div>
    </aside>
    <div className="logistics-entry-canvas">
      <header className="logistics-entry-header"><span>PackProof <b>/</b> {choices?.orders ? 'Your workspace' : 'Connect your facility'}</span>
        <button type="button" className="logistics-entry-secondary" onClick={onCommerce}>Open Commerce workspace</button></header>
      <FirstRunContent primaryLabel={primaryLabel} onPrimary={() => void open(primary)}
        disabled={checking || !choices?.[primary]} busy={busy} primaryClassName="logistics-entry-primary"
        secondaryAction={choices?.setup && choices.orders ? <button type="button" className="logistics-entry-secondary" disabled={busy} onClick={() => void open('setup')}>Facility setup</button> : undefined}>
        {error && <div className="logistics-entry-error" role="alert"><strong>Connection needs attention</strong><p>{error}</p><button type="button" onClick={() => void refresh()} disabled={checking}>Check access again</button></div>}
        {!checking && !error && choices && !choices.orders && !choices.setup && <p role="status">Your account has no available facility connection. Ask your workspace administrator to review your access, then <button type="button" className="logistics-entry-inline" onClick={() => void refresh()}>check again</button>.</p>}
      </FirstRunContent>
    </div>
  </main>;
}
