import { Glyph } from "../site/Brand";
import { Notice } from "../components/Notice";
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
      icon: "mail",
      kind: "Invitation",
      title: "Invitation received",
      subtitle: invite.transaction.itemTitle ?? "PackProof invitation",
      at: invite.createdAt,
      onPress: () => props.onAccept(invite.invitationId),
    })),
    ...props.proofs.map((item) => ({
      id: `proof-${item.proofId}`,
      icon: item.status === "FINALIZED" ? "shield" : "box",
      kind: "Proof update",
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
    <main className="page activity-page">
      <p className="workspace-overline">Workspace / Activity</p>
      <h1>Activity</h1>
      <p className="lede">Invitations, secured evidence, and finalized Proofs.</p>
      {props.error ? (
        <Notice kind="error" title="Activity is unavailable">{props.error}</Notice>
      ) : null}
      {props.loading ? (
        <p className="empty">Loading activity…</p>
      ) : items.length === 0 ? (
        <p className="empty">No recent activity. Invitations, secured evidence, and finalized Proofs will appear here.</p>
      ) : (
        <div className="card-list">
          {items.map((item) => (
            <button key={item.id} className="activity-row" type="button" onClick={item.onPress}>
              <span className={`activity-item-icon ${item.icon === "shield" ? "is-preserved" : ""}`}><Glyph name={item.icon} size={20} /></span>
              <span className="activity-item-copy"><span className="activity-kind">{item.kind}</span>
                <span className="card-title">{item.title}</span>
                <span className="meta" style={{ display: "block" }}>
                  {item.subtitle}
                </span>
              </span>
              <time className="activity-item-time" dateTime={item.at}>{formatDateTime(item.at)}</time><Glyph size={17} />
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
