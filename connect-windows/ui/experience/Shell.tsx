import { useState, type ReactNode } from "react";
import { Brand, Icon } from "./Icon";
import type { ConnectStatus } from "../types";
import "./EvidenceOS.css";

export type Section = "home" | "orders" | "attention" | "connections";

const sections = [
  ["home", "Overview", "home"],
  ["orders", "Orders & proofs", "records"],
  ["attention", "Exceptions", "attention"],
  ["connections", "Connected systems", "connection"],
] as const;

type Appearance = "dark" | "light";
const themePreference = "packproof.connect.appearance.v1";
function initialAppearance(): Appearance {
  try {
    return window.localStorage.getItem(themePreference) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function Header({
  workspace,
  action,
  onAction,
}: {
  workspace?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <header className="pp-header">
      <Brand />
      <div className="pp-header-end">
        {onAction && (
          <button className="pp-text-button" onClick={onAction}>
            {action}
          </button>
        )}
        {workspace && <span>{workspace}</span>}
      </div>
    </header>
  );
}

/**
 * Unified Logistics owner. The advanced inspection and source approval routes
 * remain in their existing, authorized implementations; this is not a second
 * renderer with mock actions. Figma nNnkgTZOBNkG8muy8AkIv1.
 */
export function Shell({
  status,
  section,
  onSection,
  children,
}: {
  status: ConnectStatus;
  section: Section;
  onSection: (section: Section) => void;
  children: ReactNode;
}) {
  const [appearance, setAppearance] = useState<Appearance>(initialAppearance);
  const ws = status.workspace;
  const activeSources = ws?.sources.filter(
    (source) => source.roles.length > 0 && source.state === "active",
  ).length ?? 0;
  const accessible =
    status.health.serviceOnline &&
    ws?.canReadOrders !== false &&
    !["unauthenticated", "forbidden", "unreachable"].includes(status.transport?.state || "");
  const running = accessible && ws?.phase === "active" && activeSources > 0;
  const statusLabel = !status.health.serviceOnline
    ? "Background service offline"
    : !accessible
      ? "Reconnection required"
      : running
        ? "Evidence collection active"
        : "Connection status";
  const statusDetail = running
    ? `${activeSources} approved ${activeSources === 1 ? "source" : "sources"} collecting`
    : accessible
      ? "Check your current connections"
      : "Open connections to investigate";
  const toggleAppearance = () => {
    const next = appearance === "dark" ? "light" : "dark";
    setAppearance(next);
    try {
      window.localStorage.setItem(themePreference, next);
    } catch {
      // A blocked local preference store must not block the live workspace.
    }
  };
  return (
    <div className="pp-window pp-evidence-os" data-appearance={appearance}>
      <aside className="pp-sidebar" aria-label="PackProof navigation">
        <div className="pp-eos-brand">
          <Brand />
        </div>
        <span className="pp-nav-label">Workspace</span>
        <nav aria-label="Workspace">
          {sections.map(([id, name, icon]) => (
            <button
              key={id}
              type="button"
              aria-current={id === section ? "page" : undefined}
              onClick={() => onSection(id)}
            >
              <Icon name={icon} size={25} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="pp-eos-nav-hint">
          <span>INSIDE EVERY PROOF</span>
          <p>Matching decisions, original evidence, integrity and history.</p>
        </div>
        <div className="pp-sidebar-foot">
          <span className={"pp-eos-health-dot" + (running ? " is-live" : " is-muted")} aria-hidden="true" />
          <div className="pp-eos-status" role="status">
            <strong>{statusLabel}</strong>
            <small>{statusDetail}</small>
          </div>
          <button type="button" className="pp-text-button" onClick={() => onSection("connections")}>
            View connection status <span aria-hidden="true">→</span>
          </button>
          <button
            type="button"
            className="pp-eos-appearance"
            onClick={toggleAppearance}
            aria-label={appearance === "dark" ? "Switch to light appearance" : "Switch to dark appearance"}
          >
            <span aria-hidden="true">{appearance === "dark" ? "◐" : "◑"}</span>
            {appearance === "dark" ? "Light appearance" : "Dark appearance"}
          </button>
        </div>
      </aside>
      <div className="pp-canvas">{children}</div>
    </div>
  );
}
