import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { CommerceConnectionView } from '../api/types';
import type { ProofSearchItem, ProofSearchQuery, ProofSearchResult, ProofSearchState } from '../../../packages/evidence-contracts/api-dashboard';

const states: Array<[ProofSearchState | '',string]> = [['','All'],['READY','Ready'],['IN_PROGRESS','In progress'],['AWAITING_CAPTURE','Awaiting capture'],['NEEDS_ATTENTION','Needs attention']];
const labels = Object.fromEntries(states) as Record<string,string>;
function reason(row:ProofSearchItem):string {
  const reasons:Record<string,string> = {PRESERVATION_FAILED:'PackProof is investigating preservation.',LEGACY_UNCONFIRMED:'Preservation has not been confirmed for this older record.',
    FINALIZATION_INCOMPLETE:'PackProof needs to review this record.',PRESERVATION_PENDING:'Preservation is in progress.',CONFIRMATION_REQUIRED:'Review and confirm the recording.',CAPTURE_REQUIRED:'Record the shipment.'};
  return row.readiness.reason ? reasons[row.readiness.reason] ?? 'Open this record for details.' : '';
}
function localTime(value:string|null):string {return value?new Date(value).toLocaleString(): '—';}
export function ClientProofDashboard(props:{api:PackProofApi;initialQuery?:string;onOpenProof:(proofId:string)=>void;onCreate:()=>void}) {
  const [draft,setDraft]=useState(props.initialQuery??''),[filters,setFilters]=useState<ProofSearchQuery>({q:props.initialQuery??'',limit:50});
  const [result,setResult]=useState<ProofSearchResult|null>(null),[loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0),[connections,setConnections]=useState<CommerceConnectionView[]>([]);
  const generation=useRef(0),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{
    let cancelled=false;
    void props.api.listCommerceConnections().then(value=>{if(!cancelled)setConnections(value.connections);}).catch(()=>{/* Search remains available when connection diagnostics are unavailable. */});
    return()=>{cancelled=true;};
  },[props.api]);
  useEffect(()=>{
    const request=++generation.current;setLoading(true);setLoadingMore(false);setError(null);setResult(null);
    void props.api.searchProofs(filters).then(value=>{if(mounted.current&&generation.current===request)setResult(value);})
      .catch(caught=>{if(mounted.current&&generation.current===request)setError(caught instanceof Error?caught.message:'Your Proofs could not be loaded.');})
      .finally(()=>{if(mounted.current&&generation.current===request)setLoading(false);});
  },[props.api,filters,refresh]);
  useEffect(()=>{
    const tick=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
    const interval=window.setInterval(tick,30000);
    const visible=()=>{if(document.visibilityState==='visible')tick();};
    document.addEventListener('visibilitychange',visible);
    return()=>{window.clearInterval(interval);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const change=(key:keyof ProofSearchQuery,value:string)=>setFilters(previous=>({...previous,[key]:value||undefined,after:undefined}));
  const more=()=>{
    if(!result?.nextCursor||loadingMore)return;
    const request=generation.current,cursor=result.nextCursor;setLoadingMore(true);setError(null);
    void props.api.searchProofs({...filters,after:cursor}).then(page=>{
      if(!mounted.current||generation.current!==request)return;
      setResult(previous=>previous?{...page,proofs:[...new Map([...previous.proofs,...page.proofs].map(row=>[row.proofId,row])).values()]}:page);
    }).catch(caught=>{if(mounted.current&&generation.current===request)setError(caught instanceof Error?caught.message:'The next page could not be loaded.');})
      .finally(()=>{if(mounted.current&&generation.current===request)setLoadingMore(false);});
  };
  return <main className="page library-page workstation-proof-page" aria-busy={loading}>
    <header className="workstation-page-heading"><div><span className="workstation-eyebrow">Your evidence, together.</span><h1 className="page-title">Your Proofs</h1><p>Find a shipment and open its recording, activity, sharing or export.</p></div><button className="btn" onClick={props.onCreate}>New Proof</button></header>
    <section className="workstation-panel workstation-proof-list" aria-label="Search and review Proofs">
      <form className="workstation-list-toolbar" role="search" onSubmit={event=>{event.preventDefault();setFilters(previous=>({...previous,q:draft.trim(),after:undefined}));}}>
        <label>Order, tracking or Proof reference<input value={draft} onChange={event=>setDraft(event.target.value)} maxLength={200} autoComplete="off" placeholder="Search item, order, tracking or Proof ID" /></label>
        <label>Status<select value={filters.state??''} onChange={event=>change('state',event.target.value)}>{states.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Created from (UTC)<input type="date" value={filters.from??''} max={filters.through} onChange={event=>change('from',event.target.value)} /></label>
        <label>Created through (UTC)<input type="date" value={filters.through??''} min={filters.from} onChange={event=>change('through',event.target.value)} /></label>
        <label>Connection<select value={filters.connectionId??''} onChange={event=>change('connectionId',event.target.value)}><option value="">All connections</option>{connections.map(connection=><option key={connection.connectionId} value={connection.connectionId}>{connection.provider} · {connection.connectionId}</option>)}</select></label>
        <button className="btn btn-secondary" type="submit">Search</button>
        <button className="btn btn-secondary" type="button" onClick={()=>{setDraft('');setFilters({limit:50});}}>Clear filters</button>
      </form>
      <div className="workstation-list-notice"><span aria-live="polite">{result?'Last updated '+localTime(result.refreshedAt):'Waiting for the server'}</span> <button className="text-link" type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>Refresh Proofs</button></div>
      {error&&<div className="workstation-list-message" role="alert"><p>{error}</p><button type="button" className="btn btn-secondary" onClick={()=>setRefresh(value=>value+1)}>Try again</button></div>}
      {loading&&<p className="workstation-list-message" role="status">Loading Proofs…</p>}
      {!loading&&result&&result.proofs.length===0&&<p className="workstation-list-message" role="status">No Proofs match these filters. Try another reference or clear the filters.</p>}
      {!loading&&result&&result.proofs.length>0&&<div style={{overflowX:'auto'}}><table className="workstation-proof-table">
        <caption>{result.proofs.length} records loaded{result.hasMore?' · more records available':''}. Ready includes confirmed preservation. Times below use your local timezone.</caption>
        <thead><tr><th scope="col">Order / Proof</th><th scope="col">Item / shipment</th><th scope="col">Submitted by / received</th><th scope="col">Status</th><th scope="col">Next action</th></tr></thead>
        <tbody>{result.proofs.map(row=><tr key={row.proofId}>
          <th scope="row"><button type="button" className="text-link" onClick={()=>props.onOpenProof(row.proofId)}>{row.externalId??row.proofId}</button>{row.externalId&&<small style={{display:'block'}}>{row.proofId}</small>}</th>
          <td>{row.itemTitle??'Shipment'}{row.itemCount>1&&<span> · {row.itemCount} line items</span>}{row.trackingNumber&&<small style={{display:'block'}}>{row.trackingNumber}</small>}</td>
          <td>{row.recordedBy??'Awaiting recording'}<small style={{display:'block'}}>{localTime(row.serverReceivedAt)}</small></td>
          <td>{labels[row.readiness.state]??row.readiness.state}</td><td>{reason(row)}</td>
        </tr>)}</tbody>
      </table></div>}
      {result?.hasMore&&<div className="workstation-list-message"><button className="btn btn-secondary" type="button" disabled={loadingMore} onClick={more}>{loadingMore?'Loading more…':'Load more Proofs'}</button></div>}
    </section>
    <p className="workstation-list-notice">A Ready record has a finalized core and recorded preservation receipts. Playback and exports follow current access and retention policy.</p>
  </main>;
}
