import { useEffect, useRef, useState } from "react";
import type { AccountDeletionRequestView, PackProofApi } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "@packproof/copy/format";
import "./account-settings.css";

const RETENTION_EXPLANATION = "Requesting account deletion starts a review. It does not immediately erase your account or shared Proofs. Some evidence and records may need to be retained for their applicable retention period, an active dispute, or a legal obligation. Your request status will explain the outcome.";
const requestLabel = (state: string) => ({ REQUESTED: "Request received", PENDING: "Request received", IN_REVIEW: "Request under review", PROCESSING: "Request being processed", COMPLETED: "Request marked completed", DECLINED: "Request declined", REJECTED: "Request needs review", CANCELLED: "Request cancelled" } as Record<string, string>)[state] ?? "Request in progress";

export function AccountDeletionRequestPanel({ api, accountKey }: { api: PackProofApi; accountKey: string }) {
  const [view, setView] = useState<AccountDeletionRequestView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setView(null); setError(null); setConfirmed(false); setBusy(false); setUncertain(false); setLoading(true);
    void api.getAccountDeletionRequest().then(next => { if (generation.current === current) setView(next); })
      .catch(() => { if (generation.current === current) setError("Your request status could not be loaded. Sign in again if your session has expired, then check again."); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [api, accountKey]);

  async function checkStatus() {
    const current = generation.current;
    setLoading(true); setError(null);
    try { const next = await api.getAccountDeletionRequest(); if (current === generation.current) { setView(next); setUncertain(false); } }
    catch { if (current === generation.current) setError("Your request status is unavailable. Please try again shortly."); }
    finally { if (current === generation.current) setLoading(false); }
  }

  async function submit() {
    if (!confirmed || busy || loading || uncertain || !view || view.request) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      const next = await api.requestAccountDeletion();
      if (current === generation.current) { setView(next); setConfirmed(false); }
    } catch {
      // A lost response does not establish failure. Read the authoritative request before offering a retry.
      try {
        const recovered = await api.getAccountDeletionRequest();
        if (current === generation.current) {
          setView(recovered); setUncertain(false);
          if (!recovered.request) setError("No request has been confirmed. Check your connection and try again.");
        }
      } catch { if (current === generation.current) { setUncertain(true); setError("We could not confirm whether your request was received. Check its status before trying again."); } }
    } finally { if (current === generation.current) setBusy(false); }
  }

  return <div className="stack" aria-label="Account deletion request">
    <p className="note">{view?.retentionNotice || RETENTION_EXPLANATION}</p>
    {loading && <p role="status">Checking your request status…</p>}
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {view?.request ? <div className="stack" role="status">
      <p><strong>{requestLabel(view.request.state)}</strong></p>
      <p className="meta">Requested {formatDateTime(view.request.requestedAt)}. Updated {formatDateTime(view.request.updatedAt)}.</p>
      <details className="settings-detail"><summary>Request reference</summary><p className="meta">{view.request.requestId}</p></details>
    </div> : view && !loading ? <div className="stack">
      <label className="channel-toggle"><input type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={event => setConfirmed(event.target.checked)} /><span>I want to request deletion of my PackProof account and understand that retained evidence may remain.</span></label>
      <button className="btn btn-danger" type="button" disabled={!confirmed || busy || uncertain} onClick={() => void submit()}>{busy ? "Sending request…" : "Request account deletion"}</button>
    </div> : null}
    <button className="btn btn-secondary" type="button" disabled={loading || busy} onClick={() => void checkStatus()}>Check request status</button>
  </div>;
}

/** Public route resource. Authentication is required only to inspect or submit a request. */
export function AccountDeletionScreen({ api, accountKey, onSignIn, onBack }: {
  api?: PackProofApi;
  accountKey?: string;
  onSignIn: () => void;
  onBack?: () => void;
}) {
  return <main className="page stack account-settings">
    <PageHeader title="Delete your PackProof account" onBack={onBack} />
    <p>{api && accountKey ? "Review the retention information and confirm if you want to request account deletion." : "You can request account deletion here. Sign in to confirm which account you want us to review."}</p>
    {api && accountKey ? <AccountDeletionRequestPanel api={api} accountKey={accountKey} /> : <section className="section stack">
      <p className="note">{RETENTION_EXPLANATION}</p>
      <button className="btn" type="button" onClick={onSignIn}>Sign in to request deletion</button>
      <p className="note">No deletion request is sent until you sign in and confirm it.</p>
    </section>}
    <a href="/new/privacy">Read the Privacy Policy</a>
  </main>;
}
