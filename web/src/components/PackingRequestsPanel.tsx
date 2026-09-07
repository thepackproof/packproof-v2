import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { ProofCollectionItem, PublicProfileView } from "../api/types";

type PackingRequest = {requestId:string;buyerUserId:string;sellerUserId:string;orderReference:string;state:string;proofId:string|null;expiresAt:string;statusText:string;cost:string};

type Props={api:PackProofApi;userId:string;proofs:ProofCollectionItem[];onOpen:(id:string)=>void};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function parseRequests(value:unknown,userId:string):PackingRequest[]{
  if(!object(value)||!Array.isArray(value.requests))throw new Error('Packing requests are temporarily unavailable.');
  return value.requests.map(row=>{
    if(!object(row)||!['requestId','buyerUserId','sellerUserId','orderReference','expiresAt','statusText','cost'].every(field=>typeof row[field]==='string')||!['REQUESTED','ACCEPTED','DECLINED','EXPIRED','CAPTURED'].includes(String(row.state))||row.proofId!==null&&typeof row.proofId!=='string'||!Number.isFinite(Date.parse(String(row.expiresAt)))||row.buyerUserId!==userId&&row.sellerUserId!==userId)throw new Error('Packing requests are temporarily unavailable.');
    return row as PackingRequest;
  });
}
export function PackingRequestsPanel(props:Props){return <ScopedPackingRequests key={JSON.stringify([props.api.recoveryScope,props.userId])} {...props}/>;}
function ScopedPackingRequests({api,userId,proofs,onOpen}:Props) {
  const mounted=useRef(true),running=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [open,setOpen]=useState(false);
  const [requests,setRequests]=useState<PackingRequest[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(""),[users,setUsers]=useState<PublicProfileView[]>([]),[seller,setSeller]=useState(""),[reference,setReference]=useState("");
  const [orders,setOrders]=useState<Record<string,string>>({}),[confirmed,setConfirmed]=useState<Record<string,boolean>>({});
  useEffect(()=>{if(!open)return;let active=true;void api.packingRequest<unknown>().then(r=>{const records=parseRequests(r,userId);if(active){setRequests(records);setError(null);}}).catch(()=>{if(active)setError("Packing requests are temporarily unavailable.");});return()=>{active=false;};},[api,userId,open]);
  const ownOrders=proofs.filter(p=>p.role==='SELLER'&&p.status!=='FINALIZED');
  async function run(action:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError(null);try{await action();if(!mounted.current)return;const records=parseRequests(await api.packingRequest<unknown>(),userId);if(mounted.current)setRequests(records);}catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The request could not be saved. Try again.");}finally{running.current=false;if(mounted.current)setBusy(false);}}
  return <section className="page"><details onToggle={e=>setOpen(e.currentTarget.open)}><summary>Request a packing Proof{requests.length?` · ${requests.length}`:""}</summary><div className="stack">
    <p>Ask a seller to record the item, packing, seal and label for your order. Requests are optional, create no charge, and do not guarantee a recording. Your order reference needs seller confirmation.</p>
    {error&&<p role="alert">{error}</p>}
    <label className="field"><span>Find the seller’s PackProof username</span><input disabled={busy} value={query} onChange={e=>{setQuery(e.target.value);setSeller("");setUsers([]);}} maxLength={100}/></label>
    <button className="btn btn-secondary" disabled={busy||query.trim().length<2} onClick={()=>void run(async()=>setUsers((await api.searchUsers(query.trim())).users.filter(u=>object(u)&&typeof u.userId==='string'&&typeof u.username==='string'&&(u.displayName==null||typeof u.displayName==='string')&&u.userId!==userId)))}>Find seller</button>
    {users.length>0&&<label className="field"><span>Seller</span><select value={seller} onChange={e=>setSeller(e.target.value)}><option value="">Choose seller</option>{users.map(u=><option key={u.userId} value={u.userId}>@{u.username}{u.displayName?` · ${u.displayName}`:""}</option>)}</select></label>}
    <label className="field"><span>Your order reference</span><input disabled={busy} value={reference} maxLength={200} onChange={e=>setReference(e.target.value)}/></label>
    <button className="btn" disabled={busy||!seller||!reference.trim()} onClick={()=>void run(async()=>{await api.packingRequest("","POST",{sellerUserId:seller,orderReference:reference.trim()});setReference("");})}>Request packing Proof</button>
    {requests.map(r=><article className="panel stack" key={r.requestId}><h3>{r.orderReference}</h3><p>{r.statusText} · {r.state.toLowerCase().replaceAll('_',' ')}</p>
      <p className="note">{r.cost} The order reference was provided by an account holder. A request does not establish a verified purchase or grant recording access.</p>
      {r.state==='REQUESTED'&&r.sellerUserId===userId&&<>
        <p>Choose the matching order. Recording time depends on the shipment. Requests expire {new Date(r.expiresAt).toLocaleDateString()}.</p>
        <label className="field"><span>Your matching order</span><select value={orders[r.requestId]??""} onChange={e=>{setOrders(old=>({...old,[r.requestId]:e.target.value}));setConfirmed(old=>({...old,[r.requestId]:false}));}}><option value="">Choose an existing order</option>{ownOrders.map(p=><option key={p.proofId} value={p.transactionId}>{p.transaction.externalReference??p.transaction.itemTitle??'Order'}</option>)}</select></label>
        <label className="row"><input type="checkbox" checked={confirmed[r.requestId]??false} onChange={e=>setConfirmed(old=>({...old,[r.requestId]:e.target.checked}))}/>I confirm this request refers to the selected order.</label>
        <div className="btn-row"><button className="btn" disabled={busy||!orders[r.requestId]||!confirmed[r.requestId]} onClick={()=>void run(async()=>{await api.packingRequest(`/${encodeURIComponent(r.requestId)}/respond`,"POST",{action:"ACCEPT",transactionId:orders[r.requestId],confirmOrderReference:true});})}>Accept request</button><button className="btn btn-secondary" disabled={busy} onClick={()=>void run(async()=>{await api.packingRequest(`/${encodeURIComponent(r.requestId)}/respond`,"POST",{action:"DECLINE"});})}>Decline</button></div>
      </>}
      {r.proofId&&r.sellerUserId===userId&&<button className="btn btn-secondary" onClick={()=>onOpen(r.proofId!)}>Open matching Proof</button>}
      {r.state==='ACCEPTED'&&r.buyerUserId===userId&&<p>The seller can separately invite you to review or contribute to the Proof.</p>}
    </article>)}
  </div></details></section>;
}
