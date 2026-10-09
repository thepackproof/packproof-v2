import { useEffect, useRef, useState } from "react";
import type { WebSession } from "../auth/session";
import { WorkstationIcon } from "../components/WorkstationHeader";

export function MobileNavigation(props: { session: WebSession; route: string; adminAllowed: boolean; onGo: (path: string) => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const go = (path: string) => { setOpen(false); props.onGo(path); };
  const tabs = [
    { label: "Home", icon: "home", path: "/app", routes: ["home"] },
    { label: "Proofs", icon: "file", path: "/proofs", routes: ["proofs", "proof", "receipt", "event", "invitation", "invite", "finalize"] },
    { label: "Pack", icon: "camera", path: "/pack", routes: ["pack", "station", "create", "scan", "capture-launch"] },
    { label: "Activity", icon: "bell", path: "/activity", routes: ["activity", "uploads"] },
  ];
  return <>
    <header className="task-mobile-header"><a href="/app" onClick={event => { event.preventDefault(); go("/app"); }}><WorkstationIcon name="shield" size={24} /><strong>PackProof</strong></a><button ref={trigger} className="task-profile-trigger" aria-label="Open profile menu" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{(props.session.displayName || props.session.username || "P").slice(0, 1).toUpperCase()}</button></header>
    <nav className="task-mobile-tabs" aria-label="Primary navigation">{tabs.map(tab => <a key={tab.path} href={tab.path} aria-current={tab.routes.includes(props.route) ? "page" : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); go(tab.path); } }}><WorkstationIcon name={tab.icon} /><span>{tab.label}</span></a>)}</nav>
    <dialog className="task-profile-dialog" ref={dialog} aria-labelledby="task-profile-title" onCancel={() => setOpen(false)} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <div className="task-section-heading"><h2 id="task-profile-title">{props.session.displayName || "Your account"}</h2><button className="btn btn-secondary" onClick={() => setOpen(false)} aria-label="Close profile menu">Close</button></div>
      <nav aria-label="Profile destinations">{[["Account and billing", "/account"], ["Settings and capture preferences", "/account"], ["Integrations", "/stores"], ["Orders", "/fulfillment"], ["Support", "/account#support"], ["Advanced tools", "/account#advanced"], ...(props.adminAllowed ? [["Administration", "/admin"]] : [])].map(([label, path]) => <a key={label} href={path} onClick={event => { event.preventDefault(); go(path); }}>{label}<span aria-hidden="true">→</span></a>)}</nav>
      <button className="btn btn-secondary" onClick={() => { setOpen(false); props.onSignOut(); }}>Sign out</button>
    </dialog>
  </>;
}
