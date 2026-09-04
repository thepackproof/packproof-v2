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

type EmailPreference = "IMPORTANT" | "ALL" | "FINAL_ONLY";
type RecipientSubscription = { email: string; preference: EmailPreference };

export function PublicProofScreen(props: {
  token: string;
  load: (token: string) => Promise<PublicProofView>;
  onSignIn: () => void;
}) {
  const [proof, setProof] = useState<PublicProofView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailSubscription, setEmailSubscription] = useState<RecipientSubscription | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    setEmailSubscription(null);
    setEmailStatus(null);
    void fetch(recipientApiUrl(props.token), { method: "GET", headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as { subscription?: RecipientSubscription };
        if (!cancelled && payload.subscription) setEmailSubscription(payload.subscription);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.token]);

  const updateEmailPreference = async (preference: EmailPreference) => {
    setEmailBusy(true);
    setEmailStatus(null);
    try {
      const response = await fetch(recipientApiUrl(props.token), {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ preference }),
      });
      if (!response.ok) throw new Error("Unable to update email preferences.");
      const payload = (await response.json()) as { subscription: RecipientSubscription };
      setEmailSubscription(payload.subscription);
      setEmailStatus("Email preferences updated.");
    } catch (caught) {
      setEmailStatus(caught instanceof Error ? caught.message : "Unable to update email preferences.");
    } finally {
      setEmailBusy(false);
    }
  };

  const unsubscribeEmail = async () => {
    setEmailBusy(true);
    setEmailStatus(null);
    try {
      const response = await fetch(recipientApiUrl(props.token), { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to stop email updates.");
      setEmailSubscription(null);
      setEmailStatus("Email updates stopped. This secure Proof link will continue to work.");
    } catch (caught) {
      setEmailStatus(caught instanceof Error ? caught.message : "Unable to stop email updates.");
    } finally {
      setEmailBusy(false);
    }
  };

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
            <h1 style={{ marginBottom: 4 }}>View Proof</h1>
            <p className="meta" style={{ marginTop: 0 }}>
              {tracker?.reference ? `Order ${tracker.reference}` : "Transaction Proof"}
              {tracker?.itemTitle ? ` · ${tracker.itemTitle}` : ""}
            </p>
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

            {emailSubscription ? (
              <section className="section stack" aria-label="Email updates">
                <div>
                  <h2>Email updates</h2>
                  <p className="note">Updates are being sent to {emailSubscription.email}. Choose how often PackProof should email you.</p>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <PreferenceButton label="Important" value="IMPORTANT" selected={emailSubscription.preference} busy={emailBusy} onSelect={updateEmailPreference} />
                  <PreferenceButton label="All milestones" value="ALL" selected={emailSubscription.preference} busy={emailBusy} onSelect={updateEmailPreference} />
                  <PreferenceButton label="Finalization only" value="FINAL_ONLY" selected={emailSubscription.preference} busy={emailBusy} onSelect={updateEmailPreference} />
                </div>
                <button className="btn btn-secondary" type="button" disabled={emailBusy} onClick={() => void unsubscribeEmail()}>
                  Stop email updates
                </button>
                {emailStatus ? <p className="meta" role="status">{emailStatus}</p> : null}
              </section>
            ) : emailStatus ? (
              <section className="section"><p className="note" role="status">{emailStatus}</p></section>
            ) : null}

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

function PreferenceButton(props: {
  label: string;
  value: EmailPreference;
  selected: EmailPreference;
  busy: boolean;
  onSelect: (value: EmailPreference) => Promise<void>;
}) {
  return (
    <button
      className={props.selected === props.value ? "btn" : "btn btn-secondary"}
      type="button"
      disabled={props.busy}
      aria-pressed={props.selected === props.value}
      onClick={() => void props.onSelect(props.value)}
    >
      {props.label}
    </button>
  );
}

function recipientApiUrl(token: string): string {
  const path = `/public/proofs/${encodeURIComponent(token)}/email-subscription`;
  const base = import.meta.env.VITE_PACKPROOF_API_BASE_URL?.trim() ?? "";
  if (!base) return path;
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
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
