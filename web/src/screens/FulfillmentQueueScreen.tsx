import type { CommerceConnectionView, FulfillmentQueueItem } from "../api/types";
import { PageHeader } from "../components/PageHeader";
import { orderReviewReason } from "@packproof/copy/commerce";

export function FulfillmentQueueScreen(props: {
  items: FulfillmentQueueItem[]; connections?: CommerceConnectionView[]; loading: boolean; error: string | null;
  onOpen: (proofId: string) => void; onBack?: () => void; onCreate?: () => void; onConnect?: () => void;
  onBatch?: () => void; onRefresh?: () => void;
}) {
  const channels = props.connections ?? [];
  const unhealthy = channels.filter(channel => channel.lastErrorCode || ["FAILED", "RETRYING"].includes(channel.sync?.runStatus || "") || ["NEEDS_REAUTH", "ERROR"].includes(channel.status));
  const needsAttention = (item: FulfillmentQueueItem) => item.pendingEvidenceCount > 0 || item.evidenceCount > 0 || item.workflowState === "IN_PROGRESS";
  const items = [...props.items].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  const lastSync = channels.map(channel => channel.lastSyncAt).filter(Boolean).sort().at(-1);
  return <main className="page orders-page"><PageHeader title="Orders" />
    {props.error ? <div className="banner banner-error" role="alert">Orders couldn’t refresh. {props.error}</div> : null}
    <div className="section-head"><h2>Ready to pack</h2><button type="button" className="btn btn-tertiary" disabled={props.loading} onClick={props.onRefresh}>{props.loading ? "Refreshing…" : "Refresh orders"}</button></div>
    {lastSync ? <p className="meta">Last successful sync {new Date(lastSync).toLocaleString()}</p> : null}
    {unhealthy.map(channel => <p className="banner" role="status" key={channel.connectionId}>{channel.providerDisplay} orders could not finish updating. {channel.status === "NEEDS_REAUTH" ? "Reconnect your account in Sales channels." : "Try refreshing again; existing orders remain available."}</p>)}
    {channels.some(c => (c.reviewOrderCount ?? 0) > 0) ? <h2>Orders requiring review</h2> : null}
    {channels.filter(c => (c.reviewOrderCount ?? 0) > 0).map(c => <div className="banner" key={c.connectionId}><strong>{c.providerDisplay}: {c.reviewOrderCount} orders need review</strong><p>{(c.reviewReasons ?? []).map(r => `${orderReviewReason(r.code)}: ${r.count}`).join(" · ")}. Check these orders in your marketplace.</p></div>)}
    {props.loading && !props.items.length ? <p role="status">Loading orders…</p> : null}
    <div className="order-list">{items.map(item => <button type="button" className="order-row" key={item.proofId} onClick={() => props.onOpen(item.proofId)}>
      <span className="order-row-copy"><strong>{item.itemSummary || "Shipment"}</strong><span>{item.providerDisplay} · {(item.externalReference || item.externalOrderId).slice(-16)}</span></span>
      <span>{needsAttention(item) ? "Finish saving" : "Ready to pack"}</span>
    </button>)}</div>
    {!props.loading && !props.items.length ? <section className="empty-card"><h2>{props.error || unhealthy.length ? "Order updates are unavailable" : channels.length ? "No orders ready to pack" : "Make a record of your next shipment"}</h2><p>Record the item as you pack and seal it. Show the shipping label in the same video.</p><div className="btn-row"><button type="button" className="btn" onClick={props.onCreate}>Record shipment</button>{!channels.length ? <button type="button" className="btn btn-tertiary" onClick={props.onConnect}>Connect a marketplace</button> : null}</div></section> : <button type="button" className="btn btn-tertiary" onClick={props.onCreate}>Order not listed?</button>}
    {props.items.length > 1 ? <button className="btn btn-tertiary" type="button" onClick={props.onBatch}>Pack multiple orders</button> : null}
  </main>;
}
