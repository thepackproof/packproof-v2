import { formatDateTime } from "@packproof/copy/format";
import { proofStatusLabel } from "@packproof/copy/status";
import type { InvitationInboxView, ProofCollectionItem } from "../api/types";

export function ActivityScreen(props: {
  proofs: ProofCollectionItem[];
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onOpenProof: (proofId: string) => void;
  onAccept: (invitationId: string) => void;
}) {
  const items = [
    ...props.invitations.map((invite) => ({
      id: `inv-${invite.invitationId}`,
      title: "Invitation received",
      subtitle: invite.transaction.itemTitle ?? "PackProof invitation",
      at: invite.createdAt,
      onPress: () => props.onAccept(invite.invitationId),
    })),
    ...props.proofs.map((item) => ({
      id: `proof-${item.proofId}`,
      title:
        item.status === "FINALIZED"
          ? "Proof finalized"
          : item.status === "EVIDENCE_COMMITTED"
            ? "Evidence secured"
            : proofStatusLabel(item.status),
      subtitle: item.transaction.itemTitle ?? "PackProof",
      at: item.finalizedAt ?? item.updatedAt,
      onPress: () => props.onOpenProof(item.proofId),
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <main className="page">
      <h1>Activity</h1>
      <p className="lede">Invitations, secured evidence, and finalized Proofs.</p>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {props.loading ? (
        <p className="empty">Loading activity…</p>
      ) : items.length === 0 ? (
        <p className="empty">No recent activity. Invitations, secured evidence, and finalized Proofs will appear here.</p>
      ) : (
        <div className="card-list">
          {items.map((item) => (
            <button key={item.id} className="activity-row" type="button" onClick={item.onPress}>
              <span>
                <span className="card-title">{item.title}</span>
                <span className="meta" style={{ display: "block" }}>
                  {item.subtitle}
                </span>
              </span>
              <span className="meta">{formatDateTime(item.at)}</span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
