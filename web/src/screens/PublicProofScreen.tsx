import { useEffect, useState } from "react";
import { ApiError } from "../api/types";
import { withRequestTimeout } from "../api/timeout";
import type { PublicProofView } from "../api/types";
import { SharedProofRecord } from "../components/SharedProofRecord";

type EmailPreference = "IMPORTANT" | "ALL" | "FINAL_ONLY";
type RecipientSubscription = { email: string; preference: EmailPreference };

export function PublicProofScreen(props: {
  token: string;
  apiBaseUrl?: string;
  load: (token: string) => Promise<PublicProofView>;
  loadMedia?: (id: string) => Promise<Blob>;
  onSignIn: () => void;
}) {
  const [retry, setRetry] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [proof, setProof] = useState<PublicProofView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailSubscription, setEmailSubscription] = useState<RecipientSubscription | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);


  useEffect(() => { setProof(null); setCheckedAt(null); }, [props.token]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let terminal = false;
    const refresh = async () => {
      if (inFlight || terminal) return;
      inFlight = true;
      try {
        const loaded = await props.load(props.token);
        if (!cancelled) {
          setProof(loaded);
          setError(null);
          setCheckedAt(new Date().toISOString());
        }
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && [401, 403, 404, 410].includes(caught.status)) {
          terminal = true;
          setProof(null);
          setEmailSubscription(null);
          setError(caught.code.includes("EXPIRED") ? "This viewing link has expired. Ask the sender for a current link." : caught.code.includes("REVOKED") ? "The sender has revoked this viewing link." : caught.status === 401 || caught.status === 403 ? "You don’t have permission to view this link." : "This viewing link is not available. Check the link with its sender.");
        } else {
          setError("Live updates are paused. Check your connection and try again. Any status shown is from the last successful update.");
        }
      } finally { inFlight = false; }
    };
    setError(null);
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [props.token, props.load, retry]);

  useEffect(() => {
    let cancelled = false;
    setEmailSubscription(null);
    setEmailStatus(null);
    void withRequestTimeout(async (signal) => {
      const response = await fetch(recipientApiUrl(props.token, props.apiBaseUrl), { method: "GET", headers: { Accept: "application/json" }, signal });
      if (!response.ok) return null;
      return response.json() as Promise<{ subscription?: RecipientSubscription }>;
    })
      .then((payload) => {
        if (!cancelled && payload?.subscription) setEmailSubscription(payload.subscription);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.token, props.apiBaseUrl]);

  const updateEmailPreference = async (preference: EmailPreference) => {
    setEmailBusy(true);
    setEmailStatus(null);
    try {
      const payload = await withRequestTimeout(async (signal) => {
        const response = await fetch(recipientApiUrl(props.token, props.apiBaseUrl), {
          method: "PATCH",
          signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ preference }),
        });
        if (!response.ok) throw new Error("Unable to update email preferences.");
        return response.json() as Promise<{ subscription: RecipientSubscription }>;
      });
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
      await withRequestTimeout(async (signal) => {
        const response = await fetch(recipientApiUrl(props.token, props.apiBaseUrl), { method: "DELETE", signal });
        if (!response.ok) throw new Error("Unable to stop email updates.");
      });
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
        <h1>Proof</h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            <p>{error}</p>
            <button type="button" className="btn btn-secondary" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {!proof && !error ? <p className="empty">Loading Proof status…</p> : null}

        {proof ? (
          <>
            <SharedProofRecord key={proof.proofId} proof={proof} loadMedia={props.loadMedia} />
            {proof.status === "FINALIZED" && proof.receipt?.mode !== "SAMPLE" && <a className="btn btn-secondary" href={`/receipt/${encodeURIComponent(proof.proofId)}`}>Document receipt or return</a>}
            {checkedAt && <p className="note" role="status">{error ? "Updates paused" : `Updated ${formatTime(checkedAt)}`}</p>}
            {emailSubscription ? (
              <section className="section stack" aria-label="Email updates">
                <div>
                  <h2>Email updates</h2>
                  <p className="note">
                    Updates are being sent to {emailSubscription.email}. Choose how often PackProof
                    should email you.
                  </p>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <PreferenceButton
                    label="Important"
                    value="IMPORTANT"
                    selected={emailSubscription.preference}
                    busy={emailBusy}
                    onSelect={updateEmailPreference}
                  />
                  <PreferenceButton
                    label="All milestones"
                    value="ALL"
                    selected={emailSubscription.preference}
                    busy={emailBusy}
                    onSelect={updateEmailPreference}
                  />
                  <PreferenceButton
                    label="Finalization only"
                    value="FINAL_ONLY"
                    selected={emailSubscription.preference}
                    busy={emailBusy}
                    onSelect={updateEmailPreference}
                  />
                </div>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={emailBusy}
                  onClick={() => void unsubscribeEmail()}
                >
                  Stop email updates
                </button>
                {emailStatus ? (
                  <p className="meta" role="status">
                    {emailStatus}
                  </p>
                ) : null}
              </section>
            ) : emailStatus ? (
              <section className="section">
                <p className="note" role="status">
                  {emailStatus}
                </p>
              </section>
            ) : null}

            {proof.join.eligible ? (
              <section className="section stack">
                <p className="note">{proof.join.message}</p>
                <button className="btn" type="button" onClick={props.onSignIn}>
                  Join PackProof
                </button>
              </section>
            ) : null}

            <p className="note">Shared for viewing. Original evidence stays unchanged.</p>
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

function recipientApiUrl(token: string, apiBaseUrl?: string): string {
  const path = `/public/proofs/${encodeURIComponent(token)}/email-subscription`;
  const base = apiBaseUrl ?? import.meta.env.VITE_PACKPROOF_API_BASE_URL?.trim() ?? "";
  if (!base) return path;
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
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
