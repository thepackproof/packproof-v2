import { useEffect, useMemo, useState } from "react";
import type { PublicProofView } from "../api/types";

type TrackerMilestone = {
  code: string;
  label: string;
  state: "COMPLETE" | "CURRENT" | "UPCOMING";
  occurredAt: string | null;
  detail: string | null;
};

type TrackerView = {
  state: "IN_PROGRESS" | "FINALIZED";
  headline: string;
  reference: string | null;
  itemTitle: string | null;
  lastUpdatedAt: string;
  shipment: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
  } | null;
  milestones: TrackerMilestone[];
};

export function PublicProofScreen(props: {
  token: string;
  load: (token: string) => Promise<PublicProofView>;
  onSignIn: () => void;
}) {
  const [proof, setProof] = useState<PublicProofView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tracker = useMemo(
    () => (proof as (PublicProofView & { tracker?: TrackerView }) | null)?.tracker ?? null,
    [proof],
  );

  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;

    const refresh = async () => {
      try {
        const loaded = await props.load(props.token);
        if (!cancelled) {
          setProof(loaded);
          setError(null);
          firstLoad = false;
        }
      } catch (caught) {
        if (!cancelled && firstLoad) {
          setError(caught instanceof Error ? caught.message : "This viewing link is not valid.");
        }
      }
    };

    setError(null);
    setProof(null);
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [props.token, props.load]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          <img src="/packproof-logo.png" alt="" width={28} height={28} />
          PackProof
        </span>
      </header>
      <main className="page stack" style={{ maxWidth: 720 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <p className="kicker">Live Proof tracker</p>
            <h1 style={{ marginBottom: 4 }}>{tracker?.reference ? `Order ${tracker.reference}` : "Transaction Proof"}</h1>
            {tracker?.itemTitle ? <p className="meta" style={{ marginTop: 0 }}>{tracker.itemTitle}</p> : null}
          </div>
          {proof ? (
            <span
              style={{
                whiteSpace: "nowrap",
                borderRadius: 999,
                padding: "7px 11px",
                fontSize: 12,
                fontWeight: 700,
                border: "1px solid var(--border)",
              }}
            >
              {proof.status === "FINALIZED" ? "Finalized" : "Live"}
            </span>
          ) : null}
        </div>

        {error ? <div className="banner banner-error" role="alert">{error}</div> : null}
        {!proof && !error ? <p className="empty">Loading Proof status…</p> : null}

        {proof ? (
          <>
            <section className="section" aria-live="polite">
              <p className="kicker">Current status</p>
              <p className="card-title" style={{ fontSize: 22 }}>{tracker?.headline || proof.nextAction?.title || statusLabel(proof.status)}</p>
              {!tracker && <p className="meta">{stageLabel(proof.workflowStage)}</p>}
              {tracker ? <p className="meta">Updated {formatTime(tracker.lastUpdatedAt)}</p> : null}
              {tracker?.shipment ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginTop: 16 }}>
                  {tracker.shipment.carrier ? <Detail label="Carrier" value={tracker.shipment.carrier} /> : null}
                  {tracker.shipment.service ? <Detail label="Service" value={tracker.shipment.service} /> : null}
                  {tracker.shipment.trackingNumber ? <Detail label="Tracking" value={tracker.shipment.trackingNumber} /> : null}
                </div>
              ) : null}
            </section>

            {tracker ? (
              <section className="section">
                <h2>Proof progress</h2>
                <div style={{ marginTop: 18 }}>
                  {tracker.milestones.map((milestone, index) => (
                    <div key={milestone.code} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 12, minHeight: 66 }}>
                      <div style={{ position: "relative", display: "flex", justifyContent: "center" }}>
                        {index < tracker.milestones.length - 1 ? (
                          <span aria-hidden="true" style={{ position: "absolute", top: 22, bottom: -4, width: 2, background: "var(--border)" }} />
                        ) : null}
                        <span
                          aria-hidden="true"
                          style={{
                            position: "relative",
                            zIndex: 1,
                            width: 20,
                            height: 20,
                            borderRadius: "50%",
                            display: "grid",
                            placeItems: "center",
                            border: "2px solid var(--border)",
                            background: milestone.state === "COMPLETE" ? "var(--text)" : "var(--surface)",
                            color: "var(--surface)",
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {milestone.state === "COMPLETE" ? "✓" : milestone.state === "CURRENT" ? "•" : ""}
                        </span>
                      </div>
                      <div style={{ paddingBottom: 18 }}>
                        <div className="card-title" style={{ opacity: milestone.state === "UPCOMING" ? 0.55 : 1 }}>{milestone.label}</div>
                        {milestone.occurredAt ? <div className="meta">{formatTime(milestone.occurredAt)}</div> : null}
                        {milestone.detail ? <div className="note" style={{ marginTop: 4 }}>{milestone.detail}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : proof.observations && proof.observations.length > 0 ? (
              <section className="section">
                <h2>Progress</h2>
                <ul className="card-list">
                  {proof.observations.map((observation, index) => (
                    <li key={`${observation.label}-${index}`}><div className="card-title">{observation.label}</div></li>
                  ))}
                </ul>
              </section>
            ) : null}

            {proof.continuity?.map((row, index) => (
              <section key={index} className="section">
                <h2>Before sending versus when received</h2>
                <p>{row.summary}</p>
              </section>
            ))}

            {proof.join.eligible ? (
              <section className="section stack">
                <p className="note">{proof.join.message}</p>
                <button className="btn" type="button" onClick={props.onSignIn}>Join PackProof</button>
              </section>
            ) : null}

            <section className="section">
              <p className="card-title">View-only record</p>
              <p className="note">This secure link can display the Proof and its progress, but it cannot add, remove, or change Proof evidence.</p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function Detail(props: { label: string; value: string }) {
  return (
    <div>
      <div className="meta">{props.label}</div>
      <div style={{ fontWeight: 650, overflowWrap: "anywhere" }}>{props.value}</div>
    </div>
  );
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "DOCUMENTING":
    case "AWAITING_DOCUMENTATION": return "Documenting items";
    case "AWAITING_PACK": return "Ready to pack";
    case "AWAITING_HANDOFF": return "Ready to hand off";
    case "IN_TRANSIT": return "Handed off";
    case "AWAITING_RECEIPT_CAPTURE":
    case "AWAITING_COMPARE": return "Received";
    case "AWAITING_RETURN":
    case "AWAITING_FINAL_RECEIPT": return "Returning";
    case "READY_TO_FINALIZE":
    case "COMPLETE": return "Complete";
    default: return "In progress";
  }
}

function statusLabel(status: string): string {
  return status === "FINALIZED" ? "Proof record sealed" : "Live Proof status";
}
