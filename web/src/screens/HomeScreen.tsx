import { useMemo, useState } from "react";
import type { InvitationInboxView, ProofCollectionItem } from "../api/types";
import { ProofSummaryCard } from "../components/ProofSummaryCard";
import { formatWhen, lifecycleLabel } from "../format";

type Filter = "all" | "active" | "completed" | "pending";

export function HomeScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onCreate: () => void;
  onAccept: (invitationId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [invitationRef, setInvitationRef] = useState("");
  const visible = useMemo(() => {
    return props.proofs.filter((item) => {
      const bucket = lifecycleLabel(item.status);
      if (filter === "active") {
        return bucket === "Active";
      }
      if (filter === "completed") {
        return bucket === "Completed";
      }
      return true;
    });
  }, [filter, props.proofs]);

  return (
    <main className="page">
      <div className="section-head">
        <div>
          <h1>Proofs</h1>
          <p className="lede">
            Discovery from the server. Opening a row loads the full canonical Proof.
          </p>
        </div>
        <button className="btn" type="button" onClick={props.onCreate}>
          Create Proof
        </button>
      </div>

      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      {props.invitations.length > 0 ? (
        <section className="section" aria-labelledby="pending-invites">
          <h2 id="pending-invites">Pending invitations</h2>
          <div className="card-list">
            {props.invitations.map((invitation) => (
              <article key={invitation.invitationId} className="invite-card">
                <div className="summary-title">
                  {invitation.transaction.itemTitle || "Invitation to a Proof"}
                </div>
                <div className="meta">
                  Pending invitation · invited by{" "}
                  {invitation.inviter.username
                    ? `@${invitation.inviter.username}`
                    : invitation.inviter.displayName || "a participant"}
                  {invitation.inviter.displayName && invitation.inviter.username
                    ? ` (${invitation.inviter.displayName})`
                    : ""}
                  · {formatWhen(invitation.createdAt)}
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => props.onAccept(invitation.invitationId)}
                >
                  Accept invitation
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <details className="section fallback-details">
        <summary>Have an invitation ID?</summary>
        <p className="note">
          Use this only if someone sent you an invitation ID. Account invitations appear above.
        </p>
        <form
          className="invite-accept"
          onSubmit={(event) => {
            event.preventDefault();
            const value = invitationRef.trim();
            if (value) {
              props.onAccept(value);
              setInvitationRef("");
            }
          }}
        >
          <label className="field">
            <span>Invitation ID</span>
            <input
              value={invitationRef}
              onChange={(event) => setInvitationRef(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="btn" type="submit" disabled={!invitationRef.trim()}>
            Accept invitation
          </button>
        </form>
      </details>

      <div className="filters" role="group" aria-label="Filter Proofs">
        {(
          [
            ["all", "All"],
            ["active", "Active"],
            ["completed", "Completed"],
            ["pending", "Pending invitations"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="chip"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {filter === "pending" ? (
        props.invitations.length === 0 ? (
          <p className="empty">No pending invitations.</p>
        ) : (
          <p className="note">Pending invitations are listed above.</p>
        )
      ) : props.loading ? (
        <p className="empty">Loading Proofs…</p>
      ) : visible.length === 0 ? (
        <div className="empty">
          <p>No Proofs to show yet.</p>
          <p>Create a Proof or accept an invitation. Discovery always comes from the server.</p>
        </div>
      ) : (
        <div className="card-list">
          {visible.map((item) => (
            <ProofSummaryCard key={item.proofId} item={item} onOpen={props.onOpenProof} />
          ))}
        </div>
      )}
    </main>
  );
}
