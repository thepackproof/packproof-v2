import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { CommerceConnectionView, FulfillmentQueueItem, ProofCollectionItem } from "../api/types";
import { Notice } from "../components/Notice";
import { WorkstationProofTable, workstationPresentation, type WorkstationProofActions } from "../components/WorkstationProofTable";
import { formatWhen } from "../format";
import { Glyph } from "../site/Brand";
import "./workstation-home.css";

export interface HomeScreenProps extends WorkstationProofActions {
  api?: PackProofApi;
  proofs: ProofCollectionItem[];
  queue: FulfillmentQueueItem[];
  connections: CommerceConnectionView[];
  loading: boolean;
  error: string | null;
  pendingUploadCount?: number;
  onGo: (path: string) => void;
  onRetry: () => void;
}

export function HomeScreen(props: HomeScreenProps) {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const proofs = [...new Map(props.proofs.map(proof => [proof.proofId, proof])).values()];
  const recent = [...proofs].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 5);
  const ready = props.queue.filter(order => order.proofStatus !== "FINALIZED" && order.workflowState !== "COMPLETED" && order.workflowState !== "REMOVED_FROM_FULFILLMENT");
  const count = (value: number) => props.loading || props.error ? "—" : value;
  const pending = props.pendingUploadCount;
  const connections = props.connections.filter(connection => ["ACTIVE", "CONNECTED"].includes(connection.status)).length;
  return <main className="page library-page workstation-home" aria-busy={props.loading}>
    <header className="workstation-page-heading"><div><span className="workstation-eyebrow">PackProof workspace</span><h1 className="page-title">Home</h1><p>Your fulfillment desk, at a glance.</p></div><button data-onboarding="create" className="btn" onClick={() => props.onGo("/new")}><Glyph name="plus" size={16} />New Proof</button></header>
    {props.error && <Notice title="We couldn’t refresh your workspace" kind="error"><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></Notice>}
    <section className="workstation-hero"><div><span className="workstation-eyebrow">Your next shipment</span><h2>Ready at the packing table.</h2><p>Select an order. Record packing. Follow its upload through confirmation.</p><button className="btn" onClick={() => props.onGo("/station")}>Open Packing Station<Glyph name="arrow" size={17} /></button></div><div className="workstation-hero-symbol" aria-hidden="true"><div className="workstation-hero-ring"><Glyph name="box" size={67} /><span><Glyph name="check" size={18} /></span></div><span>Continuous capture</span></div></section>
    <section className="workstation-metrics" aria-label="Workspace summary">
      <button onClick={() => props.onGo("/proofs?filter=attention")}><span>Needs attention</span><strong>{count(proofs.filter(proof => workstationPresentation(proof).needsAttention).length)}</strong><small>Open records requiring an action</small></button>
      <button onClick={() => props.onGo("/fulfillment")}><span>Ready to fulfill</span><strong>{count(ready.length)}</strong><small>Synchronized marketplace orders</small></button>
      <button onClick={() => props.onGo("/uploads")}><span>Pending uploads</span><strong>{pending ?? "—"}</strong><small>Recordings waiting for confirmation</small></button>
      <button onClick={() => props.onGo("/proofs?filter=completed")}><span>Completed Proofs</span><strong>{count(proofs.filter(proof => workstationPresentation(proof).completed).length)}</strong><small>Finalized shipment records</small></button>
    </section>
    <div className="workstation-home-grid">
      <section className="workstation-panel"><div className="workstation-panel-heading"><h2>Recent Proofs</h2><button className="text-link" onClick={() => props.onGo("/proofs?filter=all")}>View all <span aria-hidden="true">→</span></button></div>
        {props.loading ? <p className="workstation-list-message" role="status">Loading Proofs…</p> : props.error ? <p className="workstation-list-message">Refresh your workspace to view recent Proofs.</p> : recent.length ? <WorkstationProofTable api={props.api} proofs={recent} label="Recent Proofs" onOpenProof={props.onOpenProof} onOpenInvitation={props.onOpenInvitation} onOpenReceiver={props.onOpenReceiver} /> : <div className="workstation-empty"><span className="workstation-empty-icon"><Glyph name="file" size={25} /></span><h3>No Proofs yet</h3><p>Create a Proof to start documenting a shipment.</p><button className="text-link" onClick={() => props.onGo("/new")}>Create your first Proof <span aria-hidden="true">→</span></button></div>}
      </section>
      <aside className="workstation-panel workstation-status"><div className="workstation-panel-heading"><h2>Workspace status</h2></div><dl>
        <div><dt>Browser connection</dt><dd><span className={`workstation-badge ${online ? "is-complete" : "needs-attention"}`}>{online ? "Online" : "Offline"}</span></dd></div>
        <div><dt>Upload queue</dt><dd><button className="text-link" onClick={() => props.onGo("/uploads")}>{pending === undefined ? "Review uploads" : `${pending} pending`}</button></dd></div>
        <div><dt>Session</dt><dd>This browser tab</dd></div>
        <div><dt>Packing Station</dt><dd><button className="text-link" onClick={() => props.onGo("/station")}>Open station</button></dd></div>
        <div><dt>Marketplaces</dt><dd>{props.loading || props.error ? "—" : `${connections} connected`}</dd></div>
      </dl><div className="workstation-quiet-note"><Glyph name="shield" size={18} /><p>Upload progress is separate from Proof status. Evidence is committed after confirmation from PackProof.</p></div></aside>
    </div>
    <section className="workstation-panel"><div className="workstation-panel-heading"><h2>Fulfillment queue</h2><button className="text-link" onClick={() => props.onGo("/fulfillment")}>View orders <span aria-hidden="true">→</span></button></div>
      {props.loading ? <p className="workstation-list-message" role="status">Loading orders…</p> : props.error ? <p className="workstation-list-message">Refresh your workspace to view the fulfillment queue.</p> : ready.length ? <div className="workstation-table-scroll"><table className="workstation-proof-table workstation-order-preview" aria-label="Fulfillment queue"><thead><tr><th scope="col">Order</th><th scope="col">Marketplace</th><th scope="col">Ordered</th><th scope="col"><span className="visually-hidden">Open order</span></th></tr></thead><tbody>{ready.slice(0, 4).map(order => <tr key={order.proofId} onClick={() => props.onOpenProof(order.proofId)}><td><button className="workstation-proof-open"><span><strong>{order.externalReference || order.externalOrderId}</strong><small>{order.itemSummary}</small></span></button></td><td><span className="workstation-badge">{order.providerDisplay}</span></td><td>{formatWhen(order.orderedAt)}</td><td className="workstation-row-arrow"><Glyph name="arrow" size={17} /></td></tr>)}</tbody></table></div> : <div className="workstation-empty"><span className="workstation-empty-icon"><Glyph name="box" size={25} /></span><h3>No orders in this view</h3><p>Connected marketplace orders will appear here after they are synchronized.</p><button className="btn btn-secondary" onClick={() => props.onGo("/stores")}>Manage integrations</button></div>}
    </section>
  </main>;
}
