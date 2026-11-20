import { useEffect, useState } from 'react';
import type { PackProofDesktop } from '../shared/contracts';
import './logistics-menu.css';

export function LogisticsMenu({ bridge, busy, onReturn }: { bridge: NonNullable<PackProofDesktop['workspace']>; busy: boolean; onReturn?: () => void }) {
  const [choices,setChoices] = useState<{orders:boolean;setup:boolean} | null>(null);
  const [open,setOpen] = useState(false);
  const [working,setWorking] = useState(false);
  const [retry,setRetry] = useState(0);
  const [error,setError] = useState('');
  useEffect(() => {
    if (!open || onReturn) return;
    let current = true;
    setError(''); setChoices(null);
    void bridge.choices().then(value => { if(current)setChoices(value); }).catch((reason: unknown) => {
      if(current)setError(reason instanceof Error ? reason.message : 'Could not check facility access. Check your connection and try again.');
    });
    return () => {current=false;};
  },[bridge,open,retry,onReturn]);
  async function enter(destination:'orders'|'setup') {
    if (busy || working) return;
    setWorking(true); setError('');
    try { await bridge[destination](); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Reopen Logistics and try again.'); }
    finally { setWorking(false); }
  }
  if(onReturn)return <div className="logistics-menu"><button className="logistics-return" onClick={onReturn} disabled={busy}>← Logistics workspace</button></div>;
  return <div className="logistics-menu">
    <button aria-expanded={open} aria-controls="logistics-options" disabled={busy} onClick={()=>setOpen(value=>!value)}>Commerce <span aria-hidden="true">▾</span><span className="workspace-switch-label">Switch workspace</span></button>
    {open && <section id="logistics-options" aria-label="Logistics"><h2>Logistics</h2>
      {!error && !choices && <p role="status">Checking access…</p>}
      {choices?.orders && <button disabled={working} onClick={()=>void enter('orders')}>Orders and exceptions</button>}
      {choices?.setup && <button disabled={working} onClick={()=>void enter('setup')}>Set up this facility</button>}
      {error && <><p role="alert">{error}</p><button disabled={working} onClick={()=>setRetry(value=>value+1)}>Check access again</button></>}
    </section>}
  </div>;
}
