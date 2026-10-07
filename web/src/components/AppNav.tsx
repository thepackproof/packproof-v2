import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { WebSession } from "../auth/session";
import { WorkstationIcon, useBrowserOnline } from "./WorkstationHeader";

export type AppRouteName = "home" | "proofs" | "create" | "activity" | "account" | "proof" | "fulfillment" | "fulfillment-detail" | "station" | "stores" | "uploads";

export function AppNav(props: {
  session: WebSession; adminAllowed?: boolean; invitationCount: number;
  onGoHome: () => void; onOpenAccount: () => void; onSignOut?: () => void;
  currentRoute?: string; onGo?: (path: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const { scheme, setPreference } = useTheme();
  const online = useBrowserOnline();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => { setMobileOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!mobileOpen) return;
    drawer.current?.querySelector<HTMLAnchorElement>(".workstation-links a")?.focus();
    const onResize = () => { if (window.innerWidth > 760) setMobileOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mobileOpen]);
  const navigate = (path: string) => {
    setMobileOpen(false);
    if (props.onGo) props.onGo(path);
    else if (path === "/app") props.onGoHome();
    else props.onOpenAccount();
  };
  const links = [
    { label: "Home", href: "/app", icon: "home", active: ["home"] },
    { label: "Proofs", href: "/proofs", icon: "file", active: ["proofs", "proof", "receipt", "event", "invite", "finalize", "complete", "create", "scan"] },
    { label: "Packing Station", href: "/station", icon: "camera", active: ["station"] },
    { label: "Orders", href: "/fulfillment", icon: "box", active: ["fulfillment", "fulfillment-detail"] },
    { label: "Integrations", href: "/stores", icon: "plug", active: ["stores"] },
    { label: "Uploads", href: "/uploads", icon: "upload", active: ["uploads"] },
    { label: "Notifications", href: "/activity", icon: "bell", active: ["activity", "invitation"] },
    { label: "Settings", href: "/account", icon: "settings", active: ["account", "developer"] },
    ...(props.adminAllowed ? [{ label: "Admin", href: "/admin", icon: "grid", active: ["admin"] }] : []),
  ];
  const brand = <><span className="workstation-brand-symbol"><WorkstationIcon name="shield" size={28} /><i /></span><span>PackProof<small>WEB WORKSPACE</small></span></>;
  return <>
    <header className="workstation-mobile-top"><button ref={trigger} type="button" className="workstation-icon-button" aria-label={mobileOpen ? "Close workspace menu" : "Open workspace menu"} aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => mobileOpen ? close() : setMobileOpen(true)}><WorkstationIcon name={mobileOpen ? "close" : "menu"} /></button><a href="/app" className="workstation-brand" onClick={e => { e.preventDefault(); navigate("/app"); }}>{brand}</a></header>
    {mobileOpen && <button className="workstation-nav-backdrop" aria-label="Close workspace menu" onClick={close} tabIndex={-1} />}
    <aside ref={drawer} id="workspace-navigation" className={`workstation-nav ${mobileOpen ? "is-open" : ""}`} aria-label="Workspace navigation" onKeyDown={event => {
      if (event.key === "Escape" && mobileOpen) { event.preventDefault(); close(); }
      if (event.key === "Tab" && mobileOpen) {
        const nodes = drawer.current?.querySelectorAll<HTMLElement>(".workstation-links a, .workstation-nav-bottom button:not(:disabled)");
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <a href="/app" className="workstation-brand" onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate("/app"); } }}>{brand}</a>
      <nav aria-label="Workspace" className="workstation-links">{links.map(link => <a key={link.href} href={link.href} aria-current={link.active.includes(props.currentRoute || "home") ? "page" : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(link.href); } }}><WorkstationIcon name={link.icon} size={18} /><span>{link.label}</span>{link.href === "/activity" && props.invitationCount > 0 && <small className="workstation-nav-count">{props.invitationCount}</small>}</a>)}</nav>
      <div className="workstation-nav-bottom">
        <button type="button" className="workstation-appearance" onClick={() => setPreference(scheme === "dark" ? "light" : "dark")} aria-label={`Switch to ${scheme === "dark" ? "light" : "dark"} theme`}><WorkstationIcon name={scheme === "dark" ? "sun" : "moon"} size={16} /><span>{scheme === "dark" ? "Light appearance" : "Dark appearance"}</span></button>
        <div className="workstation-connectivity"><i className={online ? "online" : "offline"} />Browser {online ? "online" : "offline"}</div>
        <div className="workstation-profile"><button type="button" className="workstation-profile-open" onClick={() => { setMobileOpen(false); props.onOpenAccount(); }} aria-label="Open account settings"><span className="workstation-avatar">{(props.session.displayName || props.session.username || "P").slice(0, 1).toUpperCase()}</span><span><strong>{props.session.displayName || "Your account"}</strong><small>@{props.session.username || "packproof"}</small></span></button>{props.onSignOut && <button type="button" className="workstation-icon-button" onClick={props.onSignOut} aria-label="Sign out" title="Sign out"><WorkstationIcon name="logout" size={17} /></button>}</div>
      </div>
    </aside>
  </>;
}
