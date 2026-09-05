import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
type Retention = {
  protectedUntil: string | null;
  blockers: string[];
  holds: Array<{
    id: string;
    createdBy: string;
    reason: string;
    releasedAt: string | null;
  }>;
  deletionRequests: Array<{ id: string; state: string }>;
};
export function RetentionPanel({
  api,
  proofId,
  userId,
}: {
  api: PackProofApi;
  proofId: string;
  userId: string;
}) {
  const [state, setState] = useState<Retention | null>(null),
    [reason, setReason] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const reload = async () => setState(await api.retentionRequest<Retention>(proofId));
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [api, proofId]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update retention");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="section">
      <summary>Retention and preservation</summary>
      <div className="stack">
        <p className="note">
          Evidence is retained for at least 90 days after the latest finalized stage. Active holds
          and unfinished receipt or return stages block deletion review. Deletion requests are
          reviewed; they do not remove evidence immediately.
        </p>
        {state ? (
          <>
            <p>
              {state.protectedUntil
                ? `Protected through ${new Date(state.protectedUntil).toLocaleDateString()}`
                : "This Proof is active."}
            </p>
            {state.holds
              .filter((h) => !h.releasedAt)
              .map((h) => (
                <div key={h.id}>
                  <p>{h.reason}</p>
                  {h.createdBy === userId ? (
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(() => api.retentionRequest(proofId, `/holds/${h.id}`, "DELETE"))
                      }
                    >
                      Release my hold
                    </button>
                  ) : null}
                </div>
              ))}
            {state.deletionRequests.length ? (
              <p role="status">Deletion review requested. The record remains preserved.</p>
            ) : null}
          </>
        ) : null}
        <label className="field">
          <span>Reason for preservation or deletion review</span>
          <textarea maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="btn-row">
          <button
            className="btn btn-secondary"
            disabled={busy || !reason.trim()}
            onClick={() =>
              void run(() => api.retentionRequest(proofId, "/holds", "POST", { reason }))
            }
          >
            Place preservation hold
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy || !reason.trim()}
            onClick={() =>
              void run(() =>
                api.retentionRequest(proofId, "/deletion-requests", "POST", {
                  reason,
                }),
              )
            }
          >
            Request deletion review
          </button>
        </div>
        {error ? (
          <p role="alert" className="banner banner-error">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
