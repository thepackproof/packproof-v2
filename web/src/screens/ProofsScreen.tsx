import { useEffect, useState, type ReactNode } from "react";
import type { ProofCollectionItem } from "../api/types";
import type { ProofListView } from "../proof-list-state";
import { IconSearch } from "../components/Icons";
import { Notice } from "../components/Notice";
import { Glyph } from "../site/Brand";
import { formatWhen } from "../format";
import { classifyProofPresentation } from "../../../backend/src/domain/proof-presentation";

export function ProofsScreen(props: {
  proofs: ProofCollectionItem[];
  readyOrders?: ReactNode;
  view: ProofListView;
  query: string;
  loading: boolean;
  error: string | null;
  onChange: (view: ProofListView, query: string) => void;
  onRetry: () => void;
  onOpenProof: (id: string) => void;
  onOpenInvitation: (id: string) => void;
  onOpenReceiver: (id: string) => void;
  onCreate: () => void;
}) {
  const [refreshAvailable, setRefreshAvailable] = useState(false);
  useEffect(() => { const available = () => setRefreshAvailable(true); window.addEventListener("packproof:records-updated", available); window.addEventListener("online", available); return () => { window.removeEventListener("packproof:records-updated", available); window.removeEventListener("online", available); }; }, []);
  useEffect(() => { if (props.loading) setRefreshAvailable(false); }, [props.loading]);
  const [query, setQuery] = useState(props.query);
  useEffect(() => setQuery(props.query), [props.query]);
  const rows = [...new Map(props.proofs.map(item => [item.proofId, item])).values()];
  const empty = !props.loading && !props.error && !rows.length;
  return <main className="page library-page" aria-busy={props.loading}>
    <div className="workspace-heading"><div><h1 className="page-title">Proofs</h1><p>Your shipment records, from the first recording onward.</p></div><button className="btn" onClick={props.onCreate}><Glyph name="plus" size={16} />New Proof</button></div>
    {props.readyOrders}
    <div className="segmented proof-filters" role="group" aria-label="Proof filters">{([ ["all", "All"], ["attention", "Needs attention"], ["completed", "Completed"] ] as const).map(([view, label]) => <button key={view} className="segmented-tab" type="button" aria-pressed={props.view === view} onClick={() => props.onChange(view, props.query)}>{label}</button>)}</div>
    <form className="search-row" role="search" onSubmit={event => { event.preventDefault(); props.onChange(props.view, query.trim()); }}>
      <label className="search-field"><IconSearch /><span className="visually-hidden">Search proofs</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search item, order or tracking number" autoComplete="off" /></label>
      <button className="btn btn-secondary" type="submit">Search</button>
    </form>
    {props.query && <p className="active-filter-chips">Search: {props.query}<button className="text-link" onClick={() => props.onChange(props.view, "")}>Clear search</button></p>}
    {refreshAvailable && !props.loading && <p role="status">Your records may have updates. <button className="text-link" onClick={props.onRetry}>Refresh Proofs</button></p>}
    {props.error && <Notice title="We couldn’t load your Proofs" kind="error"><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></Notice>}
    {props.loading && <p role="status">Loading Proofs…</p>}
    {!props.loading && !props.error && <div className="card-list proof-list" aria-label="Proofs">
      {rows.map(item => {
        const presentation = item.presentation || classifyProofPresentation({ proofId: item.proofId, status: item.status, role: item.role, finalizedAt: item.finalizedAt });
        return <button type="button" className="proof-card proof-row" key={item.proofId} id={`proof-row-${item.proofId}`} data-context-anchor={`proof-${item.proofId}`} onClick={() => item.accessKind === "RECEIVER" ? props.onOpenReceiver(item.proofId) : item.invitationId ? props.onOpenInvitation(item.invitationId) : props.onOpenProof(item.proofId)} aria-label={`${item.transaction.itemTitle || "Untitled shipment"}. ${presentation.displayStatus}. ${presentation.nextAction.label}`}>
          <span className="proof-card-copy"><strong className="proof-card-title">{item.transaction.itemTitle || "Untitled shipment"}</strong>
            {item.transaction.externalReference && <span className="proof-row-reference">{item.transaction.externalReference}</span>}
            <span className="proof-row-status">{presentation.displayStatus}</span>
            <span className="proof-row-source">{item.source ? `${item.source} · ` : ""}Updated {formatWhen(item.updatedAt)}</span>
          </span><span className="proof-row-action">{presentation.nextAction.label}<Glyph name="arrow" size={16} /></span>
        </button>;
      })}
    </div>}
    {empty && <section className="empty-card empty-state" role="status"><h2>{props.query ? "No search matches" : props.view === "attention" ? "Nothing needs your attention" : props.view === "completed" ? "No completed Proofs yet" : "No Proofs yet"}</h2><p>{props.query ? "Try another item, order reference or tracking number." : props.view === "attention" ? "You’re up to date. Waiting and uploading records are available in All." : props.view === "completed" ? "Proofs appear here after their evidence is finalized. Delivery status is tracked separately." : "Use New Proof to record a shipment, or connect a store to bring in eligible orders automatically."}</p>{props.query ? <button className="btn btn-secondary" onClick={() => props.onChange(props.view, "")}>Clear search</button> : props.view !== "all" ? <button className="btn btn-secondary" onClick={() => props.onChange("all", "")}>View all Proofs</button> : <a className="text-link" href="/stores">Open Connections</a>}</section>}
  </main>;
}
