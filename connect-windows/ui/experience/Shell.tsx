import { createContext, useContext, useState, type ReactNode } from "react";
import { Brand, Icon } from "./Icon";
import type { ConnectStatus } from "../types";
import { canReadWorkspace } from "./WorkspaceModel";
import "./EvidenceOS.css";

export type Section = "home" | "orders" | "attention" | "connections" | "matching" | "integrity" | "exports" | "settings";

const sections = [
  ["home", "Overview", "home"],
  ["orders", "Orders & proofs", "records"],
  ["connections", "Connected systems", "connection"],
  ["matching", "Match intelligence", "records"],
  ["attention", "Exceptions", "attention"],
  ["integrity", "Evidence integrity", "records"],
  ["exports", "Exports & destinations", "folder"],
  ["settings", "Settings", "settings"],
] as const;

export type Appearance = "dark" | "light";
export type MotionPreference = "normal" | "reduced";
type ExperiencePreferences = {
  appearance: Appearance;
  motion: MotionPreference;
  selectAppearance: (value: Appearance) => void;
  selectMotion: (value: MotionPreference) => void;
};
const PreferencesContext = createContext<ExperiencePreferences | null>(null);
export function useEvidencePreferences() {
  const preferences = useContext(PreferencesContext);
  if (!preferences) throw new Error("Evidence OS settings require the connected Logistics shell.");
  return preferences;
}
const themePreference = "packproof.connect.appearance.v1";
const motionPreference = "packproof.connect.motion.v1";
function initialAppearance(): Appearance {
  try {
    return window.localStorage.getItem(themePreference) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function initialMotion(): MotionPreference {
  try {
    return window.localStorage.getItem(motionPreference) === "reduced" ? "reduced" : "normal";
  } catch {
    return "normal";
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
  const [motion, setMotion] = useState<MotionPreference>(initialMotion);
  const selectAppearance = (next: Appearance) => {
    setAppearance(next);
    try { window.localStorage.setItem(themePreference, next); }
    catch { /* A blocked local preference store must not block the workspace. */ }
  };
  const selectMotion = (next: MotionPreference) => {
    setMotion(next);
    try { window.localStorage.setItem(motionPreference, next); }
    catch { /* Reduced motion remains usable without persisted preferences. */ }
  };
  const ws = status.workspace;
  // The sidebar is part of the authorized workspace. Missing grants and
  // incompatible hosted transport must never look like active collection.
  const accessible = canReadWorkspace(status);
  const activeSources = accessible ? (ws?.sources.filter(
    (source) => source.roles.length > 0 && source.state === "active",
  ).length ?? 0) : 0;
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
  const toggleAppearance = () => selectAppearance(appearance === "dark" ? "light" : "dark");
  return (
    <PreferencesContext.Provider value={{appearance, motion, selectAppearance, selectMotion}}>
    <div className="pp-window pp-evidence-os" data-appearance={appearance} data-motion={motion}>
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
    </PreferencesContext.Provider>
  );
}
