import { useState } from "react";
import type { FulfillmentQueueItem } from "../api/types";
import { IconSearch } from "../components/Icons";
import { formatWhen } from "../format";
import { Glyph } from "../site/Brand";
import "./workstation-secondary.css";

export interface OrdersScreenProps {
  orders: FulfillmentQueueItem[];
  loading: boolean;
  error: string | null;
  syncBusy?: boolean;
  syncAvailable?: boolean;
  onSync: () => void | Promise<void>;
  onRetry: () => void;
  onOpenProof: (id: string) => void;
  onOpenStation: (id: string) => void;
  onOpenIntegrations: () => void;
  onCreate: () => void;
}

type OrderFilter = "ready" | "started" | "completed" | "all";

export function OrdersScreen(props: OrdersScreenProps) {
  const [filter, setFilter] = useState<OrderFilter>("ready");
  const [marketplace, setMarketplace] = useState("all");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [page, setPage] = useState(0);
  const providers = [...new Map(props.orders.map(order => [order.provider, order.providerDisplay])).entries()];
  const rows = props.orders.filter(order => {
    const complete = order.proofStatus === "FINALIZED";
    const removed = order.workflowState === "REMOVED_FROM_FULFILLMENT";
    if (filter === "ready" && (complete || removed)) return false;
    if (filter === "started" && (complete || removed || (!order.evidenceCount && !order.pendingEvidenceCount && order.workflowState !== "IN_PROGRESS"))) return false;
    if (filter === "completed" && !complete) return false;
    if (marketplace !== "all" && order.provider !== marketplace) return false;
    if (from || through) {
      const date = order.orderedAt ? new Date(order.orderedAt).getTime() : NaN;
      if (!Number.isFinite(date)) return false;
      if (from && date < new Date(`${from}T00:00:00`).getTime()) return false;
      if (through && date > new Date(`${through}T23:59:59.999`).getTime()) return false;
    }
    return `${order.externalOrderId} ${order.externalReference ?? ""} ${order.itemSummary}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const lastPage = Math.max(0, Math.ceil(rows.length / 40) - 1);
  const activePage = Math.min(page, lastPage);
  const filtered = !!query.trim() || marketplace !== "all" || !!from || !!through;
  function resetFilters() { setMarketplace("all"); setQuery(""); setFrom(""); setThrough(""); setPage(0); }

  return <main className="page workstation-secondary orders-page" aria-busy={props.loading}>
    <header className="workspace-heading secondary-heading">
      <div><span className="secondary-eyebrow">YOUR WORKSTATION</span><h1 className="page-title">Orders</h1><p>Synchronized orders, ready for the packing table.</p></div>
      <button className="btn" onClick={props.onCreate}><Glyph name="plus" size={18} />New Proof</button>
    </header>
    <section className="secondary-panel orders-panel" aria-label="Fulfillment orders">
      <div className="secondary-toolbar">
        <div className="secondary-tabs" role="group" aria-label="Order filters">
          {([["ready", "Needs fulfillment"], ["started", "Proof started"], ["completed", "Completed"], ["all", "All orders"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }}>{label}</button>)}
        </div>
        <div className="secondary-button-group">
          <select aria-label="Marketplace filter" value={marketplace} onChange={event => { setMarketplace(event.target.value); setPage(0); }}><option value="all">All marketplaces</option>{providers.map(([provider, label]) => <option key={provider} value={provider}>{label}</option>)}</select>
          <button className="btn btn-secondary" disabled={props.loading || props.syncBusy || props.syncAvailable === false} title={props.syncAvailable === false ? "Connect an available marketplace to synchronize orders" : undefined} onClick={() => void props.onSync()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15" /></svg>{props.syncBusy ? "Syncing…" : "Sync"}</button>
        </div>
      </div>
      <div className="secondary-order-filters">
        <label className="secondary-search"><IconSearch /><span className="visually-hidden">Search orders</span><input placeholder="Search order or item…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <label className="secondary-date">From<input type="date" aria-label="Orders from date" value={from} max={through || undefined} onChange={event => { setFrom(event.target.value); setPage(0); }} /></label>
        <label className="secondary-date">Through<input type="date" aria-label="Orders through date" value={through} min={from || undefined} onChange={event => { setThrough(event.target.value); setPage(0); }} /></label>
        {(from || through) && <button className="text-link" onClick={() => { setFrom(""); setThrough(""); setPage(0); }}>Clear dates</button>}
      </div>
      {props.error && <div className="secondary-load-error" role="alert"><strong>Orders could not be loaded</strong><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></div>}
      {props.loading && <p className="secondary-loading" role="status">Loading orders…</p>}
      {!props.loading && !props.error && (rows.length ? <>
        <div className="secondary-table-scroll"><table className="secondary-table"><thead><tr><th scope="col">Order</th><th scope="col">Marketplace</th><th scope="col">Evidence</th><th scope="col">Ordered</th><th scope="col"><span className="visually-hidden">Action</span></th></tr></thead><tbody>{rows.slice(activePage * 40, (activePage + 1) * 40).map(order => {
          const completed = order.proofStatus === "FINALIZED";
          const removed = order.workflowState === "REMOVED_FROM_FULFILLMENT";
          const tone = completed ? "success" : removed ? "neutral" : order.evidenceCount ? "info" : "warning";
          return <tr key={order.proofId}><td><button className="secondary-table-link" onClick={() => props.onOpenProof(order.proofId)}>{order.externalReference || order.externalOrderId}</button><small>{order.itemSummary}</small></td><td><span className="secondary-badge">{order.providerDisplay}</span></td><td><span className={`secondary-badge is-${tone}`}>{completed ? "Completed" : removed ? "Removed from fulfillment" : order.evidenceCount ? "Evidence added" : order.pendingEvidenceCount ? "Upload pending" : "Recording needed"}</span></td><td className="secondary-date-cell">{formatWhen(order.orderedAt)}</td><td><button className="btn btn-secondary secondary-row-action" onClick={() => completed || removed ? props.onOpenProof(order.proofId) : props.onOpenStation(order.proofId)}>{completed || removed ? "View Proof" : "Record packing"}<Glyph name="arrow" size={15} /></button></td></tr>;
        })}</tbody></table></div>
        {rows.length > 40 && <nav className="secondary-pagination" aria-label="Order pages"><span>{activePage * 40 + 1}–{Math.min((activePage + 1) * 40, rows.length)} of {rows.length} orders</span><button className="btn btn-secondary" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Previous</button><button className="btn btn-secondary" disabled={activePage === lastPage} onClick={() => setPage(activePage + 1)}>Next</button></nav>}
      </> : <div className="secondary-empty" role="status"><span className="secondary-empty-icon"><Glyph name="box" size={26} /></span><h2>No orders in this view</h2><p>{filtered ? "Try a different search, marketplace, or date range." : filter === "completed" ? "Completed marketplace Proofs will appear here after finalization." : filter === "started" ? "Orders with recording activity will appear here." : "Connected marketplace orders will appear here after they are synchronized."}</p>{filtered ? <button className="btn btn-secondary" onClick={resetFilters}>Clear filters</button> : <button className="btn btn-secondary" onClick={props.onOpenIntegrations}>Manage integrations</button>}</div>)}
    </section>
  </main>;
}
