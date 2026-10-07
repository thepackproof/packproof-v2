import type { InvitationInboxView } from "../api/types";
import { formatWhen } from "../format";
import { Glyph } from "../site/Brand";
import "./workstation-secondary.css";

export interface NotificationsScreenProps {
  invitations: InvitationInboxView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenInvitation: (id: string) => void;
}

export function NotificationsScreen(props: NotificationsScreenProps) {
  return <main className="page workstation-secondary notifications-page" aria-busy={props.loading}>
    <header className="workspace-heading secondary-heading"><div><span className="secondary-eyebrow">YOUR WORKSTATION</span><h1 className="page-title">Notifications</h1><p>Proof invitations and requests for your participation.</p></div><button className="btn btn-secondary" disabled={props.loading} onClick={props.onRetry}>Refresh</button></header>
    <section className="secondary-panel" aria-label="Proof invitations">
      {props.error && <div className="secondary-load-error" role="alert"><strong>Invitations could not be loaded</strong><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></div>}
      {props.loading && <p className="secondary-loading" role="status">Loading invitations…</p>}
      {!props.loading && !props.error && (props.invitations.length > 0 ? <div className="secondary-event-list">{props.invitations.map(invitation => <article className="secondary-event" key={invitation.invitationId}>
        <span className="secondary-empty-icon"><Glyph name="mail" size={24} /></span>
        <div className="secondary-event-body"><span className="secondary-eyebrow">PROOF INVITATION</span><h2>{invitation.transaction.itemTitle || "PackProof invitation"}</h2><p>{invitation.inviter.displayName || invitation.inviter.username || "A participant"} invited you to a Proof{invitation.transaction.externalReference ? ` · ${invitation.transaction.externalReference}` : ""}.</p><small>Received {formatWhen(invitation.createdAt)}{invitation.expiresAt ? ` · Expires ${formatWhen(invitation.expiresAt)}` : ""}</small></div>
        <button className="btn btn-secondary" onClick={() => props.onOpenInvitation(invitation.invitationId)}>Review invitation<Glyph name="arrow" size={16} /></button>
      </article>)}</div> : <div className="secondary-empty" role="status"><span className="secondary-empty-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg></span><h2>No invitations waiting</h2><p>Invitations to participate in a Proof will appear here.</p></div>)}
    </section>
  </main>;
}
