import { useEffect, useState } from 'react';
import type { PackProofDesktop } from '../shared/contracts';
import './logistics-menu.css';

export function LogisticsMenu({ bridge, busy }: { bridge: NonNullable<PackProofDesktop['workspace']>; busy: boolean }) {
  const [choices,setChoices] = useState<{orders:boolean;setup:boolean} | null>(null);
  const [open,setOpen] = useState(false);
  const [working,setWorking] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(''); setChoices(null);
    void bridge.choices().then(value => { if(current)setChoices(value); }).catch(() => {
      if(current)setError('Logistics is unavailable for this account or facility. Close and reopen to check again.');
    });
    return () => {current=false;};
  },[bridge,open]);
  async function enter(destination:'orders'|'setup') {
    if (busy || working) return;
    setWorking(true); setError('');
    try { await bridge[destination](); setOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Reopen Logistics and try again.'); }
    finally { setWorking(false); }
  }
  return <div className="logistics-menu">
    <button aria-expanded={open} aria-controls="logistics-options" disabled={busy} onClick={()=>setOpen(value=>!value)}>Commerce <span aria-hidden="true">▾</span><span className="workspace-switch-label">Switch workspace</span></button>
    {open && <section id="logistics-options" aria-label="Logistics"><h2>Logistics</h2>
      {!error && !choices && <p role="status">Checking access…</p>}
      {choices?.orders && <button disabled={working} onClick={()=>void enter('orders')}>Orders and exceptions</button>}
      {choices?.setup && <button disabled={working} onClick={()=>void enter('setup')}>Set up this facility</button>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>;
}
