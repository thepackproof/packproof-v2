import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { CommerceConnectionView } from '../api/types';
import type { ConnectionHealthView } from '../api/connection-health';

const time=(value:string|null)=>value?new Date(value).toLocaleString():'Not yet confirmed';
function ConnectionHealthCard(props:{api:PackProofApi;connection:CommerceConnectionView;busy:boolean;onSync:(id:string)=>void;onAutomation:(id:string,enabled:boolean)=>void}){
 const [expanded,setExpanded]=useState(false),[health,setHealth]=useState<ConnectionHealthView|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
 const generation=useRef(0);
 useEffect(()=>{
  if(!expanded)return;
  let cancelled=false;const request=++generation.current;
  setLoading(true);setError(null);
  void props.api.getCommerceConnectionHealth(props.connection.connectionId).then(value=>{if(!cancelled&&generation.current===request)setHealth(value);})
   .catch(caught=>{if(!cancelled&&generation.current===request){setHealth(null);setError(caught instanceof Error?caught.message:'Connection health is unavailable.');}})
   .finally(()=>{if(!cancelled&&generation.current===request)setLoading(false);});
  return()=>{cancelled=true;};
 },[props.api,props.connection.connectionId,expanded,refresh]);
 useEffect(()=>{
  if(!expanded)return;
  const tick=()=>{if(document.visibilityState==='visible')setRefresh(value=>value+1);};
  const timer=window.setInterval(tick,30000);
  document.addEventListener('visibilitychange',tick);
  return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
 },[expanded]);
 return <details className="workstation-panel" onToggle={event=>setExpanded(event.currentTarget.open)}>
  <summary>{props.connection.providerDisplay} · {props.connection.externalAccountReference??props.connection.connectionId} — Connection health</summary>
  {expanded&&<div className="stack">
   {loading&&!health&&<p role="status">Checking the connection…</p>}
   {error&&<p role="alert">{error}</p>}
   {health&&<>
    <p>{health.status==='ACTIVE'?'Authorized':'Reconnect required'} · Automatic order checks {health.automation.paused?'paused':'enabled'}.</p>
    <dl><dt>Store identity</dt><dd>{health.capabilities.stableAccountId??'Not yet confirmed'}</dd>
     <dt>Order import</dt><dd>{health.capabilities.incrementalListSupported?'Supported':'Unavailable for this connection'}</dd>
     <dt>Last successful order check</dt><dd>{time(health.sync.sourceWatermarkAt)}{health.sync.stale===true?' · Check is overdue':''}</dd>
     <dt>Source backlog</dt><dd>{health.sync.pendingProviderEvents} provider notifications pending{health.sync.pageResumePending?' · More source pages are waiting':''}</dd>
     <dt>Provider notifications</dt><dd>{health.capabilities.webhookDeliveryVerified?'Delivery observed '+time(health.capabilities.lastWebhookReceivedAt):'Delivery has not been demonstrated'}{health.capabilities.webhookSubscriptionsVerified?' · Subscriptions verified':''}</dd>
    </dl>
    <p>{health.coverage.discovered} discovered orders · {health.coverage.eligible} eligible · {health.coverage.excluded} excluded.</p>
    <p>{health.coverage.finalized} finalized · {health.coverage.inProgress} in progress · {health.coverage.awaitingCapture} awaiting capture · {health.coverage.eligibleWithoutProof} awaiting a Proof{health.coverage.otherEligible?' · '+health.coverage.otherEligible+' require review':''}.</p>
    {health.coverage.reviewOrderCount>0&&<p>{health.coverage.reviewOrderCount} excluded orders need shipment review before capture can be offered.</p>}
    <p className="muted">Coverage includes discovered source records. Finalized counts do not confirm preservation readiness; open Proofs for that status.</p>
    {health.nextAction==='RECONNECT'&&<p role="status">Reconnect this store using its connection card above.</p>}
    {health.nextAction==='NO_ORDER_IMPORT'&&<p role="status">This connection cannot import orders. Use an order-capable provider or direct integration.</p>}
    {health.nextAction==='CONTACT_SUPPORT'&&<p role="status">PackProof needs to review this connection. Your existing Proofs remain available under their access policy.</p>}
    {health.nextAction==='WAIT'&&<p role="status">PackProof is checking for source updates.</p>}
    {health.nextAction==='RETRY_SYNC'&&<button type="button" className="btn btn-secondary" disabled={props.busy} onClick={()=>props.onSync(props.connection.connectionId)}>Retry order check</button>}
    {health.nextAction==='ENABLE_AUTOMATION'&&<button type="button" className="btn btn-secondary" disabled={props.busy} onClick={()=>props.onAutomation(props.connection.connectionId,true)}>Enable automatic order checks</button>}
    <p>Last updated {time(health.observedAt)}.</p>
   </>}
   <button type="button" className="btn btn-secondary" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>Refresh connection health</button>
  </div>}
 </details>;
}
export function ConnectionHealthPanel(props:{api:PackProofApi;connections:CommerceConnectionView[];busy:boolean;onSync:(id:string)=>void;onAutomation:(id:string,enabled:boolean)=>void}){
 return <section className="stack" aria-label="Connection health and coverage"><h2>Order connection health</h2>{props.connections.length?props.connections.map(connection=><ConnectionHealthCard key={connection.connectionId} {...props} connection={connection}/>):<p>Connect an order-capable provider to see import coverage.</p>}</section>;
}
