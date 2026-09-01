import {
  awaitingEvidenceCount,
  homeSummaryLine,
  isActiveProof,
  readyToFinalizeCount,
  selectAttention,
} from "@packproof/copy/presentation";
import { displayName, firstName, greetingNow } from "@packproof/copy/format";
import type { InvitationInboxView, ProofCollectionItem } from "../api/types";
import { ProofSummaryCard } from "../components/ProofSummaryCard";

export function HomeScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  displayName: string | null;
  username: string | null;
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onCreate: () => void;
  onOpenStation: () => void;
  onOpenFulfillment: () => void;
  onOpenStores: () => void;
  onAccept: (invitationId: string) => void;
}) {
  const name = firstName(
    displayName({ displayName: props.displayName, username: props.username, fallback: "" }),
  );
  const active = props.proofs.filter((item) => isActiveProof(item.status));
  const completed = props.proofs.filter((item) => item.status === "FINALIZED");
  const attention = selectAttention({
    proofs: props.proofs,
    invitations: props.invitations,
  });
  const recent = [...active, ...completed].slice(0, 5);
  const summary = homeSummaryLine({
    activeCount: active.length,
    awaitingEvidenceCount: awaitingEvidenceCount(props.proofs),
    readyToFinalizeCount: readyToFinalizeCount(props.proofs),
    invitationCount: props.invitations.length,
  });

  return (
    <main className="page">
      <h1 className="visually-hidden">Home</h1>
      <p className="greeting">{name ? `${greetingNow()}, ${name}` : greetingNow()}</p>
      <p className="summary-line">{summary}</p>

      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}

      {attention ? (
        <article className="attention-card">
          <div className="kicker">{attention.kind === "invitation" ? "Needs attention" : "Continue"}</div>
          <h2 className="card-title">{attention.title}</h2>
          <div className="row">
            <span className="status-badge">{attention.statusLabel}</span>
            {attention.shipping ? <span className="meta">{attention.shipping}</span> : null}
          </div>
          {attention.kind === "invitation" && attention.invitationId ? (
            <button className="btn" type="button" onClick={() => props.onAccept(attention.invitationId as string)}>
              {attention.cta}
            </button>
          ) : attention.proofId ? (
            <button className="btn" type="button" onClick={() => props.onOpenProof(attention.proofId as string)}>
              {attention.cta}
            </button>
          ) : null}
        </article>
      ) : props.loading ? (
        <p className="empty">Loading PackProofs…</p>
      ) : (
        <div className="empty-card empty">
          <p>No Proofs to show yet.</p>
          <p>Your active PackProof records will appear here.</p>
          <button className="btn" type="button" onClick={props.onCreate}>
            Create PackProof
          </button>
        </div>
      )}

      <div className="ops-grid" style={{ marginTop: "1.25rem" }}>
        <button className="option-card" type="button" onClick={props.onCreate}>
          <span className="option-icon" aria-hidden="true">+</span>
          <span className="option-copy">
            <strong className="card-title">Create PackProof</strong>
            <span className="meta">Import a purchase or enter details</span>
          </span>
        </button>
        <button className="option-card" type="button" onClick={props.onOpenFulfillment}>
          <span className="option-icon" aria-hidden="true">▣</span>
          <span className="option-copy">
            <strong className="card-title">Fulfillment</strong>
            <span className="meta">Pack imported store orders</span>
          </span>
        </button>
        <button className="option-card" type="button" onClick={props.onOpenStation}>
          <span className="option-icon" aria-hidden="true">▭</span>
          <span className="option-copy">
            <strong className="card-title">Packing Station</strong>
            <span className="meta">Scan, pack, and seal evidence</span>
          </span>
        </button>
        <button className="option-card" type="button" onClick={props.onOpenStores}>
          <span className="option-icon" aria-hidden="true">⌂</span>
          <span className="option-copy">
            <strong className="card-title">Connected stores</strong>
            <span className="meta">Marketplace connections</span>
          </span>
        </button>
      </div>

      <section className="section" style={{ marginTop: "1.25rem" }}>
        <div className="section-head">
          <h2>Recent Proofs</h2>
        </div>
        {recent.length === 0 ? (
          <p className="meta">Finalized and in-progress records will show here.</p>
        ) : (
          <div className="card-list">
            {recent.map((item) => (
              <ProofSummaryCard key={item.proofId} item={item} onOpen={props.onOpenProof} />
            ))}
          </div>
        )}
      </section>

      {props.invitations.length > 0 ? (
        <section className="section" aria-labelledby="pending-invites">
          <h2 id="pending-invites">Pending invitations</h2>
          <div className="card-list">
            {props.invitations.map((invitation) => (
              <article key={invitation.invitationId} className="invite-card">
                <div className="kicker">You’ve been invited to a PackProof</div>
                <div className="summary-title">
                  {invitation.transaction.itemTitle || "PackProof invitation"}
                </div>
                <div className="meta">
                  {invitation.inviter.username
                    ? `@${invitation.inviter.username}`
                    : invitation.inviter.displayName || "A participant"}{" "}
                  invited you
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => props.onAccept(invitation.invitationId)}
                >
                  Review
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
