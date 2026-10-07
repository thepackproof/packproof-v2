import { useEffect, useState, type ReactNode } from "react";
import { Glyph } from "../site/Brand";

export function useBrowserOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  return online;
}

export function WorkstationIcon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    home: <path d="m3 10 9-7 9 7v11h-6v-8H9v8H3Z" />,
    shield: <path d="m12 3 8 4v6c0 4-8 9-8 9s-8-5-8-9V7Z" />,
    camera: <><rect x="3" y="6" width="13" height="12" rx="1" /><path d="m16 10 5-3v10l-5-3" /></>,
    plug: <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0ZM12 17v5" /></>,
    upload: <path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7" />,
    bell: <path d="M5 9a7 7 0 0 1 14 0c0 7 2 8 2 8H3s2-1 2-8M9 21h6" />,
    settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
    refresh: <path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" />,
    logout: <path d="M10 3H4v18h6M9 12h12m-4-4 4 4-4 4" />,
  };
  if (!paths[name]) return <Glyph name={name} size={size} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function WorkstationHeader({ route, refreshing, onRefresh }: { route: string; refreshing?: boolean; onRefresh: () => void }) {
  const titles: Record<string, string> = { home: "Home", proofs: "Proofs", station: "Packing Station", fulfillment: "Orders", stores: "Integrations", uploads: "Uploads", activity: "Notifications", account: "Settings", create: "New Proof", proof: "Proof", receipt: "Receipt", invite: "Invite participant", invitation: "Invitation", finalize: "Finalize Proof", developer: "Developer tools", event: "Evidence event" };
  const refreshable = ["home", "proofs", "fulfillment", "stores", "uploads", "activity", "account"].includes(route);
  return <header className="workstation-topbar"><div className="workstation-breadcrumb"><strong>WORKSPACE</strong><span aria-hidden="true">/</span><span>{titles[route] || "Proofs"}</span></div><div className="workstation-topbar-actions"><span><WorkstationIcon name="shield" size={15} />Evidence workspace</span>{refreshable && <button type="button" className="workstation-icon-button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh workspace" title="Refresh workspace"><WorkstationIcon name="refresh" size={18} /></button>}</div></header>;
}
