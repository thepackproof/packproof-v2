import type { CommerceConnectionView, FulfillmentQueueItem } from "../api/types";
import { orderReviewReason } from "@packproof/copy/commerce";
import { PageHeader } from "../components/PageHeader";
import { formatMoney } from "../format";

export function FulfillmentQueueScreen(props: {
  items: FulfillmentQueueItem[];
  connections?: CommerceConnectionView[];
  loading: boolean;
  error: string | null;
  onOpen: (proofId: string) => void;
  onBack?: () => void;
}) {
  const readyCount = props.items.length;
  const reviewConnections = (props.connections ?? []).filter(connection => (connection.reviewOrderCount ?? 0) > 0);
  return (
    <main className="page">
      <PageHeader title="Orders" onBack={props.onBack} />
      <div className="section-head">
        <p className="lede">
          Orders imported from a connected store. Pack, record evidence, and complete the PackProof.
        </p>
        <span className="badge badge-state">Ready to pack {readyCount}</span>
      </div>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      {reviewConnections.length > 0 ? <section className="section stack" aria-label="Orders requiring review">
        <h2>Orders requiring review</h2>
        {reviewConnections.map(connection => <div key={connection.connectionId}>
          <p className="card-title">{connection.providerDisplay}: {connection.reviewOrderCount} orders need review</p>
          <p className="meta">{(connection.reviewReasons ?? []).map(reason => `${orderReviewReason(reason.code)}: ${reason.count}`).join(" · ")}</p>
        </div>)}
        <p className="note">These orders are excluded from the automatic packing queue. Review their fulfillment details in the original selling platform before recording. Any existing Proof history is kept.</p>
      </section> : null}
      {props.loading ? (
        <p className="empty">Loading fulfillment queue…</p>
      ) : props.items.length === 0 ? (
        <p className="empty">{reviewConnections.length ? "No eligible orders are ready to record. The orders above need review." : "No orders are waiting to be packed. Check Connections for your store’s automatic intake status."}</p>
      ) : (
        <div className="card-list">
          {props.items.map((item) => (
            <article key={item.proofId} className="fulfillment-card">
              <div>
                <div className="summary-title">Order #{item.externalReference || item.externalOrderId}</div>
                <div className="meta">{item.itemSummary}</div>
                {item.itemCount > 1 ? (
                  <div className="meta">{item.itemCount} line items</div>
                ) : null}
                <div className="meta">
                  {formatMoney(item.transactionValue, item.currency)} · {item.providerDisplay}
                </div>
              </div>
              <button className="btn" type="button" onClick={() => props.onOpen(item.proofId)}>
                Record packing
              </button>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
