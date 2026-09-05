import { useState } from "react";
import type { CanonicalProof } from "../api/types";
import { formatWhen } from "../format";

export function EvidenceReviewPanel(props: {
  proof: CanonicalProof;
  onVerify?: () => Promise<{
    integrity: { manifestDigestValid: boolean; manifestSha256: string } | null;
  }>;
  onExport?: () => Promise<void>;
}) {
  const [verification, setVerification] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const accesses = (props.proof.events ?? []).filter((e) =>
    ["PROOF_ACCESSED", "PROOF_VIEWED_VIA_ACCESS_LINK", "PROOF_PACKAGE_EXPORTED"].includes(
      e.eventType,
    ),
  );
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section stack">
      <h2>Claims review</h2>
      <p className="note">
        Inspect the recorded evidence, its source, and the order of events. PackProof preserves the
        record; the reviewer decides the claim.
      </p>
      <dl className="summary-facts">
        <dt>Created</dt>
        <dd>{formatWhen(props.proof.createdAt)}</dd>
        <dt>Finalized</dt>
        <dd>{props.proof.finalizedAt ? formatWhen(props.proof.finalizedAt) : "Not finalized"}</dd>
        <dt>Manifest SHA-256</dt>
        <dd className="secret-value">
          {props.proof.integrity?.manifestSha256 ?? "Available after finalization"}
        </dd>
      </dl>
      {props.proof.status === "FINALIZED" ? (
        <div className="btn-row">
          {props.onVerify ? (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const review = await props.onVerify!();
                  setVerification(
                    review.integrity?.manifestDigestValid
                      ? "The canonical manifest matches its stored SHA-256 digest."
                      : "The manifest could not be verified.",
                  );
                })
              }
            >
              Verify manifest
            </button>
          ) : null}
          {props.onExport ? (
            <button className="btn" disabled={busy} onClick={() => void run(props.onExport!)}>
              Download evidence package
            </button>
          ) : null}
        </div>
      ) : null}
      {verification ? <p role="status">{verification}</p> : null}
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <details>
        <summary>Access history ({accesses.length})</summary>
        {accesses.length ? (
          <ul>
            {accesses.map((e) => (
              <li key={e.eventId}>
                {formatWhen(e.at)} · {e.eventType.toLowerCase().replaceAll("_", " ")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">No recorded viewer access in this snapshot.</p>
        )}
      </details>
    </section>
  );
}
