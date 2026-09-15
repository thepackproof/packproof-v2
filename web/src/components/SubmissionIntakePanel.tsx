import { useEffect, useRef, useState } from "react";
import type { IntakePreview } from "@packproof/copy/order-intake";
import type { PackProofApi } from "../api/client";
import { randomId } from "../random-id";
import { IntakePanel } from "./IntakePanel";

export interface IntakeSubmission {
  submissionId: string; clientSubmissionId: string;
  state: "RECEIVED" | "RESOLVING" | "READY" | "NEEDS_CONNECTION" | "NEEDS_SELECTION" | "INVALID" | "RETRYABLE_FAILED" | "DISMISSED";
  proofId: string | null; transactionId: string | null; nextAction: string;
  retryable: boolean; errorCode: string | null; updatedAt: string; message: string;
  candidates: Array<{ candidateId: string; orderReference: string; itemSummary: string; provider: string; transactionId: string }>;
}

export function SubmissionIntakePanel({ api, userId, onPreview, onReview, onOpenProof }: {
  api: PackProofApi; userId: string;
  onPreview: (text: string) => Promise<IntakePreview>; onReview: (preview: IntakePreview) => void;
  onOpenProof: (proofId: string) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<IntakeSubmission | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false), [title, setTitle] = useState(""), [reference, setReference] = useState("");
  const [fullPhysicalOrder, setFullPhysicalOrder] = useState(false);
  const delivery = useRef<{ clientSubmissionId: string; text: string } | null>(null);
  const inFlight = useRef(false);
  const receiptKey = `packproof.intake-receipt:${api.recoveryScope}:${userId}`;
  useEffect(() => {
    let active = true;
    void api.intakeRequest<{ submissionEnabled?: boolean }>("/capabilities").then(async capabilities => {
      if (!active) return;
      setEnabled(capabilities.submissionEnabled === true);
      // Keep only an opaque, account-partitioned receipt across reloads.
      // Read admitted work even when a rollout flag pauses new submissions.
      let receipt: string | null = null;
      try { receipt = sessionStorage.getItem(receiptKey); } catch { /* Server queue remains available. */ }
      if (receipt) {
        const saved = await api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(receipt)}`);
        if (active) setResult(saved);
      }
    }).catch(() => { if (active) { setEnabled(false); setError("Saved order intake is unavailable. You can still review pasted details manually."); } });
    return () => { active = false; };
  }, [api, receiptKey]);

  async function save(request: () => Promise<IntakeSubmission>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const saved = await request();
      setResult(saved);
      try { sessionStorage.setItem(receiptKey, saved.submissionId); } catch { /* Durable server receipt already exists. */ }
      // Raw pasted order details are no longer needed once the server accepts.
      setText(""); delivery.current = null;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add this order. Try again."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function submit() {
    if (!text.trim()) return;
    if (!delivery.current || delivery.current.text !== text) delivery.current = { clientSubmissionId: randomId(), text };
    const current = delivery.current;
    void save(() => api.intakeRequest<IntakeSubmission>("/submissions", "POST", {
      schemaVersion: 1, clientSubmissionId: current.clientSubmissionId, surface: "EXPLICIT_PASTE", requestedAction: "QUEUE", payload: { kind: "TEXT", text: current.text },
    }));
  }
  const resolved = result?.state === "READY" && result.proofId;
  return <section className="section stack">
    {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
    {enabled === null ? <p role="status">Checking order intake…</p> : enabled === false && !result ? <IntakePanel onPreview={onPreview} onReview={onReview} /> : <>
      <h2>Paste order details</h2>
      {!result ? <form className="stack" onSubmit={event => { event.preventDefault(); submit(); }}>
        <p>Paste the order text or link you want to add. PackProof checks your connected accounts and existing orders.</p>
        <label className="field"><span>Order text or link</span><textarea rows={6} maxLength={20000} value={text} onChange={event => setText(event.target.value)} /></label>
        <button className="btn" disabled={busy || !text.trim()}>{busy ? "Adding order…" : "Find order"}</button>
      </form> : <div className="stack">
        <p role="status">{result.message || (resolved ? "This order is ready in your packing queue." : "Your order input has been saved. Check the order before recording.")}</p>
        {result.proofId ? <button className="btn" onClick={() => onOpenProof(result.proofId!)}>{resolved ? "Open order" : "Review order"}</button> : null}
        {result.state === "NEEDS_CONNECTION" ? <a className="btn btn-secondary" href="/stores">Connect selling account</a> : null}
        {result.state === "NEEDS_SELECTION" ? <div className="stack">{result.candidates.map(candidate => <button key={candidate.candidateId} className="btn btn-secondary" disabled={busy} onClick={() => void save(() => api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(result.submissionId)}/resolve`, "POST", { candidateId: candidate.candidateId }))}>{candidate.orderReference} · {candidate.itemSummary}</button>)}</div> : null}
        {result.retryable || ["RECEIVED", "RESOLVING"].includes(result.state) ? <button className="btn btn-secondary" disabled={busy} onClick={() => void save(() => result.state === "RETRYABLE_FAILED" ? api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(result.submissionId)}/resolve`, "POST", {}) : api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(result.submissionId)}`))}>{result.state === "RETRYABLE_FAILED" ? "Try adding again" : "Check order status"}</button> : null}
        {!result.proofId && !["RECEIVED", "RESOLVING", "DISMISSED"].includes(result.state) ? <>
          <button className="btn btn-tertiary" onClick={() => setManual(!manual)}>Enter order details manually</button>
          {manual ? <form className="stack" onSubmit={event => { event.preventDefault(); if (!fullPhysicalOrder) return; void save(() => api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(result.submissionId)}/resolve`, "POST", { confirmed: true, details: { itemTitle: title.trim(), physicalFulfillment: true, paid: true, fulfillmentScope: "FULL_ORDER", ...(reference.trim() ? { externalReference: reference.trim() } : {}) } })); }}>
            <p>These details are supplied by you. Confirm the item and order before recording.</p>
            <label className="field"><span>What are you shipping?</span><input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
            <label className="field"><span>Order number (optional)</span><input maxLength={200} value={reference} onChange={event => setReference(event.target.value)} /></label>
            <label><input type="checkbox" checked={fullPhysicalOrder} onChange={event => setFullPhysicalOrder(event.target.checked)} /> This is a paid order for physical items, and I am packing the entire order.</label>
            <button className="btn" disabled={busy || !title.trim() || !fullPhysicalOrder}>Confirm order details</button>
          </form> : null}
          <button className="btn btn-tertiary" disabled={busy} onClick={() => void save(() => api.intakeRequest<IntakeSubmission>(`/submissions/${encodeURIComponent(result.submissionId)}/dismiss`, "POST", {}))}>Dismiss saved input</button>
        </> : null}
        {result.proofId || result.state === "DISMISSED" ? <button className="btn btn-tertiary" onClick={() => { setResult(null); setManual(false); setTitle(""); setReference(""); setFullPhysicalOrder(false); try { sessionStorage.removeItem(receiptKey); } catch {} }}>Add another order</button> : null}
      </div>}
    </>}
  </section>;
}
