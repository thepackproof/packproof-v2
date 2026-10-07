import type { PackProofApi } from "../api/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProofCollectionItem } from "../api/types";
import type { ProofListView } from "../proof-list-state";
import { IconSearch } from "../components/Icons";
import { Notice } from "../components/Notice";
import { WorkstationProofTable } from "../components/WorkstationProofTable";
import { Glyph } from "../site/Brand";
import "./workstation-home.css";

export function ProofsScreen(props: {
  api?: PackProofApi;
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
  const search = useRef<HTMLInputElement>(null);
  const [refreshAvailable, setRefreshAvailable] = useState(false);
  useEffect(() => {
    const available = () => setRefreshAvailable(true);
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("packproof:records-updated", available);
    window.addEventListener("online", available);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("packproof:records-updated", available);
      window.removeEventListener("online", available);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);
  useEffect(() => { if (props.loading) setRefreshAvailable(false); }, [props.loading]);
  const [query, setQuery] = useState(props.query);
  useEffect(() => setQuery(props.query), [props.query]);
  const rows = [...new Map(props.proofs.map(item => [item.proofId, item])).values()];
  const empty = !props.loading && !props.error && !rows.length;
  return <main className="page library-page workstation-proof-page" aria-busy={props.loading}>
    <header className="workstation-page-heading"><div><span className="workstation-eyebrow">Your workspace</span><h1 className="page-title">Proofs</h1><p>Shipment evidence, organized and ready to review.</p></div><button data-onboarding="create capture" className="btn" onClick={props.onCreate}><Glyph name="plus" size={16} />New Proof</button></header>
    {props.readyOrders}
    <section className="workstation-panel workstation-proof-list">
      <div className="workstation-list-toolbar">
        <div className="workstation-tabs" role="group" aria-label="Proof filters">{([["all", "All"], ["attention", "Needs attention"], ["completed", "Completed"]] as const).map(([view, label]) => <button data-onboarding={view === "attention" ? "attention" : view === "completed" ? "status" : undefined} key={view} type="button" aria-pressed={props.view === view} onClick={() => props.onChange(view, props.query)}>{label}</button>)}</div>
        <form className="workstation-proof-search" role="search" onSubmit={event => { event.preventDefault(); props.onChange(props.view, query.trim()); }}>
          <label className="workstation-search-field"><IconSearch /><span className="visually-hidden">Search proofs</span><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search order, item, tracking…" autoComplete="off" /><kbd aria-hidden="true">Ctrl K</kbd></label>
          <button className="btn btn-secondary" type="submit">Search</button>
        </form>
      </div>
      {props.query && <p className="workstation-list-notice">Search: {props.query}<button className="text-link" onClick={() => props.onChange(props.view, "")}>Clear search</button></p>}
      {refreshAvailable && !props.loading && <p className="workstation-list-notice" role="status">Your records may have updates. <button className="text-link" onClick={props.onRetry}>Refresh Proofs</button></p>}
      {props.error && <div className="workstation-list-message"><Notice title="We couldn’t load your Proofs" kind="error"><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></Notice></div>}
      {props.loading && <p className="workstation-list-message" role="status">Loading Proofs…</p>}
      {!props.loading && !props.error && rows.length > 0 && <div data-onboarding="proofs"><WorkstationProofTable api={props.api} proofs={rows} onOpenProof={props.onOpenProof} onOpenInvitation={props.onOpenInvitation} onOpenReceiver={props.onOpenReceiver} /></div>}
      {empty && <section data-onboarding="proofs" className="workstation-empty" role="status"><span className="workstation-empty-icon"><Glyph name="file" size={25} /></span><h2>{props.query ? "No search matches" : props.view === "attention" ? "Nothing needs your attention" : props.view === "completed" ? "No completed Proofs yet" : "No Proofs yet"}</h2><p>{props.query ? "Try another item, order reference or tracking number." : props.view === "attention" ? "You’re up to date. Waiting and uploading records are available in All." : props.view === "completed" ? "Proofs appear here after their evidence is finalized. Delivery status is tracked separately." : "Use New Proof to record a shipment, or connect a store to bring in eligible orders automatically."}</p>{props.query ? <button className="btn btn-secondary" onClick={() => props.onChange(props.view, "")}>Clear search</button> : props.view !== "all" ? <button className="btn btn-secondary" onClick={() => props.onChange("all", "")}>View all Proofs</button> : <a className="text-link" href="/stores">Open Integrations</a>}</section>}
    </section>
  </main>;
}
