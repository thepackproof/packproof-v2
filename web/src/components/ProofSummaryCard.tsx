import { formatDate, orderReferenceLabel, roleLabel, shippingSummary } from "@packproof/copy/format";
import { humanProofStatus, integrityState } from "@packproof/copy/status";
import type { ProofCollectionItem } from "../api/types";

export function ProofSummaryCard(props: {
  item: ProofCollectionItem;
  onOpen: (proofId: string) => void;
}) {
  const title = props.item.transaction.itemTitle?.trim() || "Untitled item";
  const status = humanProofStatus({ proofStatus: props.item.status });
  const shipping = shippingSummary({
    carrier: props.item.transaction.carrier,
    trackingNumber: props.item.transaction.trackingNumber,
  });
  const integrity = integrityState({ proofStatus: props.item.status });
  return (
    <article className="summary-card">
      <div className="row">
        <span
          className={
            integrity === "finalized" || integrity === "secured"
              ? "status-badge status-badge-success"
              : "status-badge"
          }
        >
          {status}
        </span>
        <span className="meta">{roleLabel(props.item.role)}</span>
        {integrity !== "none" ? (
          <span className="integrity-mark">{integrity === "finalized" ? "Sealed" : "Evidence secured"}</span>
        ) : null}
      </div>
      <h2 className="summary-title">{title}</h2>
      <div className="meta">
        {orderReferenceLabel(props.item.transaction.externalReference) || "No order reference"}
        {shipping ? ` · ${shipping}` : ""}
      </div>
      <div className="meta">{formatDate(props.item.finalizedAt ?? props.item.updatedAt ?? props.item.createdAt)}</div>
      <button type="button" className="btn" onClick={() => props.onOpen(props.item.proofId)}>
        Open Proof
      </button>
    </article>
  );
}
