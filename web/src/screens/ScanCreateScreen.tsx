import { useState } from "react";
import { ApiError } from "../api/types";
import type { PackingStationResolveView } from "../api/types";
import { PageHeader } from "../components/PageHeader";

type Phase = "reference" | "found" | "missing";

export function ScanCreateScreen(props: {
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onIdentify: (reference: string) => Promise<PackingStationResolveView>;
  onContinue: (transactionId: string) => void;
  onImport: () => void;
  onManual: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("reference");
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<PackingStationResolveView | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function identify() {
    const value = reference.trim();
    if (!value) {
      return;
    }
    setLocalError(null);
    try {
      const resolved = await props.onIdentify(value);
      setResult(resolved);
      setPhase("found");
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "STATION_REFERENCE_NOT_FOUND" || caught.code === "TRANSACTION_NOT_FOUND")
      ) {
        setResult(null);
        setPhase("missing");
        setLocalError(caught.message);
      }
    }
  }

  const error = localError || props.error;

  return (
    <main className="page scan-create stack">
      <PageHeader title={phase === "found" ? "Order found" : "Scan order"} onBack={props.onBack} />
      {phase === "reference" ? (
        <>
          <p className="lede">Enter an order, tracking, or reference number.</p>
          {error ? (
            <div className="banner banner-error" role="alert">
              {error}
            </div>
          ) : null}
          <label className="field">
            <span>Reference</span>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <button className="btn" type="button" disabled={props.busy || !reference.trim()} onClick={() => void identify()}>
            {props.busy ? "Looking up…" : "Continue"}
          </button>
        </>
      ) : null}

      {phase === "found" && result ? (
        <article className="info-card">
          <h2 className="card-title">{result.itemSummary}</h2>
          <p className="meta">{result.orderLabel}</p>
          {result.trackingHint ? <p className="meta">{result.trackingHint}</p> : null}
          {result.proofId ? <p className="meta">A PackProof already exists for this order.</p> : null}
          <div className="btn-row" style={{ marginTop: "0.75rem" }}>
            <button className="btn" type="button" disabled={props.busy} onClick={() => props.onContinue(result.transactionId)}>
              {props.busy ? "Opening…" : result.proofId ? "Open existing Proof" : "Continue"}
            </button>
            <button
              className="btn btn-tertiary"
              type="button"
              onClick={() => {
                setPhase("reference");
                setResult(null);
              }}
            >
              Scan again
            </button>
          </div>
        </article>
      ) : null}

      {phase === "missing" ? (
        <article className="info-card">
          <p>We couldn’t find a matching order.</p>
          {error ? <p className="note">{error}</p> : null}
          <div className="btn-row" style={{ marginTop: "0.75rem" }}>
            <button className="btn" type="button" onClick={props.onImport}>
              Import purchase
            </button>
            <button className="btn btn-secondary" type="button" onClick={props.onManual}>
              Enter manually
            </button>
            <button
              className="btn btn-tertiary"
              type="button"
              onClick={() => {
                setPhase("reference");
                setLocalError(null);
              }}
            >
              Scan again
            </button>
          </div>
        </article>
      ) : null}
    </main>
  );
}
