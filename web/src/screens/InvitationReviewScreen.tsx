import { displayName, orderReferenceLabel } from "@packproof/copy/format";
import type { InvitationInboxView } from "../api/types";
import { PageHeader } from "../components/PageHeader";

export function InvitationReviewScreen(props: {
  invite: InvitationInboxView | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onReview: () => void;
}) {
  if (!props.invite) {
    return (
      <main className="page stack">
        <PageHeader title="Invitation" onBack={props.onBack} />
        <p>This invitation is no longer available.</p>
      </main>
    );
  }
  const inviter = displayName({
    displayName: props.invite.inviter.displayName,
    username: props.invite.inviter.username,
    fallback: "A participant",
  });
  return (
    <main className="page stack">
      <PageHeader title="You’ve been added to a PackProof" onBack={props.onBack} />
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <article className="info-card">
        <h2 className="card-title">{props.invite.transaction.itemTitle ?? "PackProof invitation"}</h2>
        {props.invite.transaction.externalReference ? (
          <p className="meta">{orderReferenceLabel(props.invite.transaction.externalReference)}</p>
        ) : null}
      </article>
      <article className="info-card">
        <div className="kicker">Seller</div>
        <p>{inviter}</p>
      </article>
      <p className="note">Joining records your participation. It does not confirm the contents of the package.</p>
      <button className="btn" type="button" disabled={props.busy} onClick={props.onReview}>
        {props.busy ? "Joining…" : "Review Proof"}
      </button>
    </main>
  );
}
