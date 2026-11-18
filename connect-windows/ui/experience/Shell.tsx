import type { ReactNode } from "react";
import { Brand, Icon } from "./Icon";
import type { ConnectStatus } from "../types";
export type Section = "home" | "orders" | "attention" | "connections";
const sections = [
  ["home", "Home", "home"],
  ["orders", "Orders", "records"],
  ["attention", "Needs attention", "attention"],
  ["connections", "Connections", "connection"],
] as const;
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
  const running =
    status.health.serviceOnline &&
    status.workspace?.phase === "active" &&
    status.workspace.sources.some((s) => s.state === "active");
  return (
    <div className="pp-window">
      <aside className="pp-sidebar">
        <span className="pp-nav-label">Workspace</span>
        <nav aria-label="Workspace">
          {sections.map(([id, name, icon]) => (
            <button key={id} aria-current={id === section ? "page" : undefined} onClick={() => onSection(id)}>
              <Icon name={icon} size={28} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="pp-sidebar-foot">
          <strong>
            {running
              ? "Collection is running"
              : status.health.serviceOnline
                ? "Connection status"
                : "Service offline"}
          </strong>
          <button className="pp-text-button" onClick={() => onSection("connections")}>
            View connection status
          </button>
        </div>
      </aside>
      <div className="pp-canvas">{children}</div>
    </div>
  );
}
