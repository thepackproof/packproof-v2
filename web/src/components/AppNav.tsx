import { useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { WebSession } from "../auth/session";
import { Brand, Glyph } from "../site/Brand";

export type AppRouteName =
  | "home"
  | "proofs"
  | "create"
  | "activity"
  | "account"
  | "proof"
  | "fulfillment"
  | "fulfillment-detail"
  | "station"
  | "stores";

export function AppNav(props: {
  session: WebSession;
  invitationCount: number;
  onGoHome: () => void;
  onOpenAccount: () => void;
  currentRoute?: string;
  onGo?: (path: string) => void;
}) {
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const { scheme, setPreference } = useTheme();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("packproof.sidebar.collapsed") === "true"; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleCollapsed = () => setCollapsed(previous => {
    try { localStorage.setItem("packproof.sidebar.collapsed", String(!previous)); } catch { /* Usable without storage. */ }
    return !previous;
  });
  const navigate = (path: string) => {
    setMobileOpen(false);
    if (props.onGo) props.onGo(path);
    else if (path === "/app") props.onGoHome();
    else props.onOpenAccount();
  };
  const links = [
    { label: "Proofs", href: "/proofs", icon: "shield", active: ["proofs", "proof", "receipt", "event", "invite", "finalize", "complete", "create", "scan", "station"] },
    { label: "Connections", href: "/stores", icon: "store", active: ["stores"] },
  ];
  return (
    <><header className="workspace-mobile-top" onKeyDown={event => { if (event.key === "Escape") setMobileOpen(false); }}><button ref={mobileTrigger} className="icon-button" aria-label={mobileOpen ? "Close workspace menu" : "Open workspace menu"} aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(!mobileOpen)}><Glyph name={mobileOpen ? "close" : "menu"} /></button><Brand /></header><aside id="workspace-navigation" className={`workspace-nav ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "mobile-expanded" : ""}`} onKeyDown={event => { if (event.key === "Escape") { setMobileOpen(false); mobileTrigger.current?.focus(); } }}><Brand />
      <div className="workspace-switcher"><span>{(props.session.displayName || "P").slice(0,1).toUpperCase()}</span><div><strong>Personal workspace</strong><small>Your shipment records</small></div></div>
      <span className="workspace-label">Workspace</span>
      <nav className="workspace-links" aria-label="Workspace">{links.map(link => <a key={link.href} href={link.href} title={link.label} aria-current={link.active.includes(props.currentRoute || "home") ? "page" : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(link.href); } }}><Glyph name={link.icon} size={18} /><span className="workspace-link-label">{link.label}</span>{link.href === "/activity" && props.invitationCount > 0 ? <span className="nav-count">{props.invitationCount}</span> : null}</a>)}</nav>
      <details className="account-menu"><summary aria-label="Account menu"><span className="account-menu-label" hidden={collapsed}>{props.session.displayName || "Your account"}</span><Glyph name="settings" size={17} /></summary><nav className="account-menu-items" aria-label="Account">
        <a href="/account" onClick={e => { e.preventDefault(); navigate("/account"); }}>Account settings</a>
        <a href="/developer" onClick={e => { e.preventDefault(); navigate("/developer"); }}>Developer tools</a>
        <a href="/contact">Help &amp; feedback</a>
      </nav></details>
      <div className="sidebar-tools"><button type="button" className="sidebar-theme" onClick={() => setPreference(scheme === "dark" ? "light" : "dark")} aria-label={`Switch to ${scheme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${scheme === "dark" ? "light" : "dark"} theme`}><Glyph name={scheme === "dark" ? "sun" : "moon"} size={18} /><span>{scheme === "dark" ? "Light appearance" : "Dark appearance"}</span></button><button className="sidebar-collapse icon-button" onClick={toggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}><Glyph name="panel" size={18} /></button></div>

    </aside></>
  );
}
