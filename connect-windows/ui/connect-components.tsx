import { useEffect, useRef, type ReactNode } from "react";
import type { ConnectView } from "./connect-view";
import { type ConnectStatus, type LocalAnalysis } from "./types";

const fields = [
  ["shipmentReference", "Shipment number"],
  ["itemTitle", "Contents"],
  ["quantity", "Quantity"],
  ["shippedAt", "Shipment date and time"],
  ["trackingNumber", "Tracking number"],
  ["carrier", "Carrier"],
  ["locationId", "Location"],
] as const;
export const label = (field: string) =>
  fields.find(([key]) => key === field)?.[1] ?? field;
export const stamp = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" })
    : "Not reported";
export const friendlyFolder = (value?: string) =>
  value?.split(/[\\/]/).filter(Boolean).at(-1) || "Approved shipment folder";
const phaseText: Record<string, string> = {
  permission_review:
    "Review the exact configuration and initial-original scope in your browser. Nothing is uploaded before that approval.",
  cloud_preview_pending:
    "The approved original is being preserved and its server interpretation checked.",
  batch_review:
    "Review and approve this exact shipment batch in your browser. Record creation needs this separate approval.",
  first_import_pending:
    "Waiting for durable import outcomes and retrieval of the actual shipment record.",
  recurring_approval_pending:
    "Your first record is verified. Review the separate permission for ongoing collection.",
  active: "The background service has acknowledged ongoing collection.",
  needs_review:
    "The first import needs attention. Pending originals and receipts remain preserved.",
  needs_retry:
    "Your saved setup needs a retry. Refresh status before continuing.",
  revoked: "Access was revoked. Ask your administrator to authorize recovery.",
};
export function ShipmentPreview({
  analysis,
  uploaded,
}: {
  analysis: LocalAnalysis;
  uploaded: boolean;
}) {
  const shipment = analysis.shipment as unknown as
    Record<string, unknown> | undefined;
  const value = (field: string) => {
    const d = analysis.decisions.find((item) => item.field === field);
    return d?.state === "validated" && shipment?.[field] != null
      ? String(shipment[field])
      : "Needs review";
  };
  return (
    <article className="shipment-card" aria-label="Shipment preview">
      <div className="shipment-caption">
        <span>SHIPMENT FROM YOUR REPORT</span>
        <span className="pill">
          {uploaded
            ? "Original uploaded · local interpretation"
            : "Local preview — nothing uploaded"}
        </span>
      </div>
      <h2>{value("shipmentReference")}</h2>
      <p className="shipment-contents">{value("itemTitle")}</p>
      <dl className="shipment-facts">
        <div>
          <dt>Quantity</dt>
          <dd>
            {value("quantity")} <span className="fact-unit">units</span>
          </dd>
        </div>
        <div>
          <dt>Source shipment date</dt>
          <dd>{value("shippedAt")}</dd>
        </div>
      </dl>
      <p className="source-caption">
        From your CSV · {analysis.rowCount} shipment{" "}
        {analysis.rowCount === 1 ? "row" : "rows"} checked
      </p>
    </article>
  );
}
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="connect-facts">{children}</dl>;
}
export function Fact({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{children ?? "Not reported"}</dd>
    </div>
  );
}
export function ApprovalJourney({
  status,
  phases,
}: {
  status: ConnectStatus;
  phases: ConnectView["phases"];
}) {
  const phase = status.setup?.phase || "";
  return (
    <div className="approval-journey">
      <ol aria-label="Connection approval progress">
        {phases.map((item, index) => (
          <li
            key={item.id}
            className={
              item.state === "complete"
                ? "done"
                : item.state === "current"
                  ? "current"
                  : ""
            }
            aria-current={item.state === "current" ? "step" : undefined}
          >
            <span className="phase-marker" aria-hidden="true">
              {item.state === "complete" ? "✓" : index + 1}
            </span>
            <div>
              <strong>{item.label}</strong>
              <small>
                {index === 0
                  ? "Exact source and original scope"
                  : index === 1
                    ? "Separate batch approval and verified Proof"
                    : "Separate recurring permission"}
              </small>
            </div>
          </li>
        ))}
      </ol>
      <p role="status" className="setup-progress">
        {phaseText[phase] ||
          "The service is checking the saved approval request. No new permission is granted by this check."}
      </p>
    </div>
  );
}
export function AdvancedDrawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null),
    close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="advanced-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]',
              ) ?? [],
            );
            const first = nodes[0],
              last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="drawer-heading">
          <div>
            <span className="eyebrow">SOURCE SETTINGS</span>
            <h2 id="advanced-title">{title}</h2>
          </div>
          <button
            ref={close}
            className="secondary icon-button"
            onClick={onClose}
            aria-label="Close advanced settings"
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
