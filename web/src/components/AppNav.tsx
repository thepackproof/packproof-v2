import { useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { WebSession } from "../auth/session";
import { AvatarButton } from "./AvatarButton";
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
    { label: "Overview", href: "/app", icon: "grid", active: ["home"] },
    { label: "Orders", href: "/fulfillment", icon: "box", active: ["fulfillment", "fulfillment-detail", "station"] },
    { label: "Proofs", href: "/proofs", icon: "shield", active: ["proofs", "proof", "receipt", "event", "invite", "finalize", "complete", "create", "scan"] },
    { label: "Connections", href: "/stores", icon: "store", active: ["stores"] },
  ];
  return (
    <><header className="workspace-mobile-top" onKeyDown={event => { if (event.key === "Escape") setMobileOpen(false); }}><button ref={mobileTrigger} className="icon-button" aria-label={mobileOpen ? "Close workspace menu" : "Open workspace menu"} aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(!mobileOpen)}><Glyph name={mobileOpen ? "close" : "menu"} /></button><Brand /></header><aside id="workspace-navigation" className={`workspace-nav ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "mobile-expanded" : ""}`} onKeyDown={event => { if (event.key === "Escape") { setMobileOpen(false); mobileTrigger.current?.focus(); } }}><Brand />
      <div className="workspace-switcher"><span>{(props.session.displayName || "P").slice(0,1).toUpperCase()}</span><div><strong>Personal workspace</strong><small>Your shipment records</small></div></div>
      <span className="workspace-label">WORKSPACE</span>
      <nav className="workspace-links" aria-label="Workspace">{links.map(link => <a key={link.href} href={link.href} title={link.label} aria-current={link.active.includes(props.currentRoute || "home") ? "page" : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(link.href); } }}><Glyph name={link.icon} size={18} /><span className="workspace-link-label">{link.label}</span>{link.href === "/activity" && props.invitationCount > 0 ? <span className="nav-count">{props.invitationCount}</span> : null}</a>)}</nav>
      <nav className="workspace-secondary" aria-label="Workspace resources"><a href="/activity" onClick={e => { e.preventDefault(); navigate("/activity"); }}><Glyph name="activity" size={17}/><span className="workspace-link-label">Activity{props.invitationCount ? ` (${props.invitationCount})` : ""}</span></a><a title="Developer tools" href="/developer" onClick={e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); navigate("/developer"); } }}><Glyph name="code" size={17} /><span className="workspace-link-label">Developer tools</span></a><a title="Help & feedback" href="/contact"><Glyph name="mail" size={17} /><span className="workspace-link-label">Help & feedback</span></a><a title="Account settings" href="/account" onClick={e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); navigate("/account"); } }}><Glyph name="settings" size={17} /><span className="workspace-link-label">Account settings</span></a></nav>
      <div className="sidebar-tools"><button type="button" className="sidebar-theme" onClick={() => setPreference(scheme === "dark" ? "light" : "dark")} aria-label={`Switch to ${scheme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${scheme === "dark" ? "light" : "dark"} theme`}><Glyph name={scheme === "dark" ? "sun" : "moon"} size={18} /><span>{scheme === "dark" ? "Light appearance" : "Dark appearance"}</span></button><button className="sidebar-collapse icon-button" onClick={toggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}><Glyph name="panel" size={18} /></button></div>
      <div className="workspace-account"><AvatarButton displayName={props.session.displayName} username={props.session.username} notify={props.invitationCount > 0} onPress={() => { setMobileOpen(false); props.onOpenAccount(); }} /><div><strong>{props.session.displayName || "Your account"}</strong><span>@{props.session.username || "packproof"}</span></div></div>
    </aside></>
  );
}
