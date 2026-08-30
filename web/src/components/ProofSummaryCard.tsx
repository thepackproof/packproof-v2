import type { ProofCollectionItem } from "../api/types";
import { formatWhen, lifecycleLabel, statusLabel } from "../format";
import { CopyableId } from "./CopyableId";

export function ProofSummaryCard(props: {
  item: ProofCollectionItem;
  onOpen: (proofId: string) => void;
}) {
  const title = props.item.transaction.itemTitle || "Untitled transaction";
  return (
    <article className="summary-card">
      <div className="row">
        <span className="badge badge-state">{lifecycleLabel(props.item.status)}</span>
        <span className="meta">{props.item.role.toLowerCase()}</span>
      </div>
      <h2 className="summary-title">{title}</h2>
      <div className="meta">{statusLabel(props.item.status)}</div>
      <div className="meta">
        {props.item.transaction.externalReference
          ? `Reference ${props.item.transaction.externalReference}`
          : "No external reference"}
        {props.item.transaction.trackingNumber
          ? ` · Tracking ${props.item.transaction.trackingNumber}`
          : ""}
      </div>
      <div className="meta">
        Created {formatWhen(props.item.createdAt)}
        {props.item.finalizedAt ? ` · Completed ${formatWhen(props.item.finalizedAt)}` : ""}
      </div>
      <CopyableId value={props.item.proofId} label="Proof ID" />
      <button type="button" className="btn" onClick={() => props.onOpen(props.item.proofId)}>
        Open Proof
      </button>
    </article>
  );
}
