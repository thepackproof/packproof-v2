import { useEffect, useState } from "react";
import type { PublicProofView } from "../api/types";

export function PublicProofScreen(props: {
  token: string;
  load: (token: string) => Promise<PublicProofView>;
  onSignIn: () => void;
}) {
  const [proof, setProof] = useState<PublicProofView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setProof(null);
    void props
      .load(props.token)
      .then((loaded) => {
        if (!cancelled) {
          setProof(loaded);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "This viewing link is not valid.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.token]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          <img src="/packproof-logo.png" alt="" width={28} height={28} />
          PackProof
        </span>
      </header>
      <main className="page stack">
        <p className="kicker">Proof status</p>
        <h1>View Proof</h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {!proof && !error ? <p className="empty">Loading status…</p> : null}
        {proof ? (
          <>
            <section className="section">
              <p className="card-title">{proof.nextAction?.title || statusLabel(proof.status)}</p>
              <p className="meta">{stageLabel(proof.workflowStage)}</p>
              {proof.nextAction?.hint ? <p className="note">{proof.nextAction.hint}</p> : null}
            </section>
            {proof.observations && proof.observations.length > 0 ? (
              <section className="section">
                <h2>Progress</h2>
                <ul className="card-list">
                  {proof.observations.map((observation, index) => (
                    <li key={`${observation.label}-${index}`}>
                      <div className="card-title">{observation.label}</div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {proof.transfers?.map((transfer, index) =>
              transfer.intervalNote ? (
                <p key={index} className="note">
                  {transfer.intervalNote}
                </p>
              ) : null,
            )}
            {proof.continuity?.map((row, index) => (
              <section key={index} className="section">
                <h2>Before sending versus when received</h2>
                <p>{row.summary}</p>
              </section>
            ))}
            {proof.join.eligible ? (
              <section className="section stack">
                <p className="note">{proof.join.message}</p>
                <button className="btn" type="button" onClick={props.onSignIn}>
                  Join PackProof
                </button>
              </section>
            ) : null}
            <p className="note">This link is view-only. It cannot change the Proof.</p>
          </>
        ) : null}
      </main>
    </div>
  );
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "DOCUMENTING":
    case "AWAITING_DOCUMENTATION":
      return "Documenting items";
    case "AWAITING_PACK":
      return "Ready to pack";
    case "AWAITING_HANDOFF":
      return "Ready to hand off";
    case "IN_TRANSIT":
      return "Handed off";
    case "AWAITING_RECEIPT_CAPTURE":
    case "AWAITING_COMPARE":
      return "Received";
    case "AWAITING_RETURN":
    case "AWAITING_FINAL_RECEIPT":
      return "Returning";
    case "READY_TO_FINALIZE":
    case "COMPLETE":
      return "Complete";
    default:
      return "In progress";
  }
}

function statusLabel(status: string): string {
  if (status === "FINALIZED") {
    return "Proof record sealed";
  }
  return "Live Proof status";
}
