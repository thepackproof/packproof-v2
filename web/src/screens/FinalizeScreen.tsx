import { useState } from "react";
import { FINALIZE_DISCLOSURE } from "@packproof/copy/errors";
import { displayName, orderReferenceLabel, shippingSummary } from "@packproof/copy/format";
import type { CanonicalProof } from "../api/types";
import { PageHeader } from "../components/PageHeader";

export function FinalizeScreen(props: {
  proof: CanonicalProof | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onFinalize: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const proof = props.proof;
  if (!proof) {
    return (
      <main className="page">
        <PageHeader title="Finalize PackProof" onBack={props.onBack} />
        <p className="empty">This Proof is not available.</p>
      </main>
    );
  }
  const txn = proof.transaction;
  const buyer = proof.participants.find((participant) => participant.role === "BUYER");
  return (
    <main className="page stack">
      <PageHeader title="Finalize PackProof" onBack={props.onBack} />
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <article className="info-card">
        <Row label="Order" value={orderReferenceLabel(txn.externalReference) || "No order reference"} />
        <Row label="Item" value={txn.itemTitle || "Untitled item"} />
        <Row
          label="Buyer"
          value={buyer ? displayName({ fallback: "Buyer joined" }) : "No buyer on this record yet"}
        />
        <Row label="Shipping" value={shippingSummary(txn.shipping ?? {}) || "No shipping details"} />
        <Row
          label="Evidence"
          value={proof.evidence.some((item) => item.validationStatus === "COMMITTED") ? "Evidence secured" : "Not secured"}
        />
      </article>
      <p className="note">{FINALIZE_DISCLOSURE}</p>
      <button className="btn" type="button" disabled={props.busy} onClick={() => setConfirmOpen(true)}>
        Finalize PackProof
      </button>
      {confirmOpen ? (
        <div className="action-sheet" role="dialog" aria-labelledby="finalize-confirm-title">
          <h2 id="finalize-confirm-title" className="card-title">
            Finalize PackProof
          </h2>
          <p className="note">{FINALIZE_DISCLOSURE}</p>
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={() => {
                setConfirmOpen(false);
                props.onFinalize();
              }}
            >
              {props.busy ? "Finalizing…" : "Finalize PackProof"}
            </button>
            <button className="btn btn-secondary" type="button" disabled={props.busy} onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div>
      <div className="kicker">{props.label}</div>
      <p>{props.value}</p>
    </div>
  );
}
