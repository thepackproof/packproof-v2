import { useMemo, useState } from "react";
import { isActiveProof } from "@packproof/copy/presentation";
import type { InvitationInboxView, ProofCollectionItem } from "../api/types";
import { ProofSummaryCard } from "../components/ProofSummaryCard";

type Filter = "active" | "completed" | "invitations";

export function ProofsScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onCreate: () => void;
  onAccept: (invitationId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("active");
  const active = useMemo(() => props.proofs.filter((item) => isActiveProof(item.status)), [props.proofs]);
  const completed = useMemo(
    () => props.proofs.filter((item) => item.status === "FINALIZED"),
    [props.proofs],
  );

  return (
    <main className="page">
      <div className="section-head">
        <div>
          <h1>Proofs</h1>
          <p className="lede">Your PackProof records, loaded from the server.</p>
        </div>
        <button className="btn" type="button" onClick={props.onCreate}>
          Create PackProof
        </button>
      </div>

      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      <div className="filters" role="tablist" aria-label="Filter Proofs">
        {(
          [
            ["active", "Active"],
            ["completed", "Completed"],
            ["invitations", "Invitations"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="chip"
            role="tab"
            aria-selected={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {filter === "invitations" ? (
        props.invitations.length === 0 ? (
          <p className="empty">You don’t have any pending invitations.</p>
        ) : (
          <div className="card-list">
            {props.invitations.map((invitation) => (
              <article key={invitation.invitationId} className="invite-card">
                <div className="kicker">You’ve been invited to a PackProof</div>
                <div className="summary-title">
                  {invitation.transaction.itemTitle || "PackProof invitation"}
                </div>
                <button className="btn" type="button" onClick={() => props.onAccept(invitation.invitationId)}>
                  Review
                </button>
              </article>
            ))}
          </div>
        )
      ) : props.loading ? (
        <p className="empty">Loading Proofs…</p>
      ) : filter === "completed" ? (
        completed.length === 0 ? (
          <p className="empty">Finalized Proofs will appear here.</p>
        ) : (
          <div className="card-list">
            {completed.map((item) => (
              <ProofSummaryCard key={item.proofId} item={item} onOpen={props.onOpenProof} />
            ))}
          </div>
        )
      ) : active.length === 0 ? (
        <div className="empty-card empty">
          <p>No Proofs to show yet.</p>
          <p>Your active PackProof records will appear here.</p>
          <button className="btn" type="button" onClick={props.onCreate}>
            Create PackProof
          </button>
        </div>
      ) : (
        <div className="card-list">
          {active.map((item) => (
            <ProofSummaryCard key={item.proofId} item={item} onOpen={props.onOpenProof} />
          ))}
        </div>
      )}
    </main>
  );
}
