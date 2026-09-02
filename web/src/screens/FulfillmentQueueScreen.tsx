import type { FulfillmentQueueItem } from "../api/types";
import { PageHeader } from "../components/PageHeader";
import { formatMoney } from "../format";

export function FulfillmentQueueScreen(props: {
  items: FulfillmentQueueItem[];
  loading: boolean;
  error: string | null;
  onOpen: (proofId: string) => void;
  onBack?: () => void;
}) {
  const readyCount = props.items.length;
  return (
    <main className="page">
      <PageHeader title="Fulfillment" onBack={props.onBack} />
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
      {props.loading ? (
        <p className="empty">Loading fulfillment queue…</p>
      ) : props.items.length === 0 ? (
        <p className="empty">No orders are ready to pack.</p>
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
                Pack
              </button>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
