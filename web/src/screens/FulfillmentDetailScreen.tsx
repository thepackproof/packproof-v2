import type { FulfillmentQueueItem } from "../api/types";
import { formatMoney } from "../format";

export function FulfillmentDetailScreen(props: {
  item: FulfillmentQueueItem | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onAttest: () => void;
  onComplete: () => void;
  onCompleteAndNext: () => void;
  onOpenProof: () => void;
}) {
  if (props.loading && !props.item) {
    return (
      <main className="page">
        <p className="empty">Loading order…</p>
      </main>
    );
  }
  if (!props.item) {
    return (
      <main className="page">
        {props.error ? (
          <div className="banner banner-error" role="alert">
            {props.error}
          </div>
        ) : (
          <p className="empty">This order is not in the fulfillment queue.</p>
        )}
      </main>
    );
  }
  const item = props.item;
  return (
    <main className="page stack">
      <header className="header-block">
        <h1>Order #{item.externalReference || item.externalOrderId}</h1>
        <p className="lede">Imported from {item.providerDisplay}. Buyer acceptance is not required.</p>
      </header>
      {props.error ? (
        <div className="banner banner-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <section className="section">
        <h2>Order</h2>
        <ul className="item-list">
          {item.items.map((line, index) => (
            <li key={line.itemId ?? `${line.position}-${index}`}>
              <strong>{line.title || "Item"}</strong>
              <div className="meta">
                Qty {line.quantity ?? 1}
                {line.unitValue != null
                  ? ` · ${formatMoney(line.unitValue, line.currency ?? item.currency)}`
                  : ""}
              </div>
            </li>
          ))}
        </ul>
        <p className="meta">
          {formatMoney(item.transactionValue, item.currency)} total
        </p>
      </section>
      <section className="section">
        <h2>Packing confirmation</h2>
        <p className="note">
          This is a user attestation. PackProof records it. It does not independently verify the
          pack.
        </p>
        {item.sellerPackingAttested ? (
          <p className="banner banner-info">Packing attestation recorded</p>
        ) : (
          <label className="check-row">
            <input
              type="checkbox"
              checked={false}
              disabled={props.busy}
              onChange={() => props.onAttest()}
            />
            <span>I attest that I packed this order as described.</span>
          </label>
        )}
      </section>
      <section className="section">
        <h2>Optional documentation</h2>
        <p className="note">
          Packing media can be added before completion. Video is not required. Use the mobile app
          to record packing video on this same PackProof.
        </p>
        {item.evidenceCount > 0 ? (
          <p className="meta">{item.evidenceCount} committed media item{item.evidenceCount === 1 ? "" : "s"}</p>
        ) : null}
        <button className="btn btn-secondary" type="button" onClick={props.onOpenProof}>
          Open full PackProof
        </button>
      </section>
      <div className="btn-row">
        <button
          className="btn"
          type="button"
          disabled={props.busy || !item.canComplete}
          onClick={props.onCompleteAndNext}
        >
          Complete & Next
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={props.busy || !item.canComplete}
          onClick={props.onComplete}
        >
          Complete PackProof
        </button>
      </div>
    </main>
  );
}
