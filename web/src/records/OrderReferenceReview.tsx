import { useState } from 'react';
import type { PackProofApi } from '../api/client';
import { displayState } from './model';
import { useWorkflowCommand, useWorkflowData } from './workflow';

type SourceRef = { namespace: string; type: string; id: string };
interface WaitingEvent { eventKey: string; sourceId: string; fileName: string; locator: string; entity: SourceRef; references: SourceRef[]; kind: string; reason: string }
interface Match { proofId: string; revision: number; orderReference: string; updatedAt: string }
interface LinkProps { api: PackProofApi; scope: string; eventKey: string; revision: number; proofId: string; onSaved: () => void }

function LinkDecision({ api, scope, eventKey, revision, proofId, onSaved, action }: LinkProps & {action:'link'|'unlink'}) {
  const [reason, setReason] = useState('');
  const command = useWorkflowCommand(api, [scope,eventKey,revision,proofId,action].join('/'));
  const params = new URLSearchParams(scope);
  async function save() {
    const result = await command.run('/order-proofs/' + encodeURIComponent(proofId) + '/associations?' + scope, {
      organizationId:params.get('organizationId'), environment:params.get('environment'), eventKey, action, expectedRevision:revision, reason:reason.trim(),
    });
    if (result) onSaved();
  }
  return <form onSubmit={event => {event.preventDefault(); if (reason.trim()) void save();}}>
    <label>Reason for this change<input maxLength={500} value={reason} required onChange={e => setReason(e.target.value)}/></label>
    <button className="records-button" disabled={!reason.trim() || command.busy}>{command.busy ? 'Saving…' : action === 'link' ? 'Link this report' : 'Remove this link'}</button>
    {command.error && <p role="alert">{command.error}</p>}
  </form>;
}
export function RemoveOrderLink(props: LinkProps) {
  return <details><summary>Correct this link</summary><p>Removing this link creates a new order revision. Earlier revisions retain the original decision.</p>
    <LinkDecision {...props} action="unlink"/></details>;
}
function ChooseOrder({ api, scope, item, onSaved }: {api:PackProofApi;scope:string;item:WaitingEvent;onSaved:()=>void}) {
  const [input,setInput]=useState(''), [query,setQuery]=useState(''), [choice,setChoice]=useState('');
  const result=useWorkflowData<{orders:Match[]}>(api, query ? '/order-proofs?' + scope + '&limit=20&q=' + encodeURIComponent(query) : null);
  const order=result.data?.orders.find(o=>o.proofId===choice);
  return <details><summary>Choose the matching order</summary>
    <form onSubmit={e=>{e.preventDefault();setChoice('');setQuery(input.trim());}}>
      <label>Order number<input required maxLength={200} value={input} onChange={e=>{setInput(e.target.value);setChoice('');setQuery('');}}/></label>
      <button className="records-button secondary">Find matching orders</button>
    </form>
    {result.loading && <p role="status">Checking orders…</p>}
    {result.error && <p role="alert">{result.error}</p>}
    {result.data && !result.error && (result.data.orders.length ? <fieldset><legend>Compare the order with the report</legend>
      {result.data.orders.map(o=><label key={o.proofId} className="agent-check"><input type="radio" name={item.eventKey} checked={o.proofId===choice} onChange={()=>setChoice(o.proofId)}/>
        {o.orderReference} · Updated {new Date(o.updatedAt).toLocaleString()} · <a href={'/app/order-proofs/'+encodeURIComponent(o.proofId)+'?'+scope} target="_blank" rel="noreferrer">Open order</a>
      </label>)}</fieldset> : <p>No matching order was found.</p>)}
    {order && <LinkDecision key={order.proofId+':'+order.revision} api={api} scope={scope} eventKey={item.eventKey} revision={order.revision} proofId={order.proofId} action="link" onSaved={onSaved}/>}
  </details>;
}
export function OrderReferenceReview({api,scope,canManage}: {api:PackProofApi;scope:string;canManage:boolean}) {
  const [refresh,setRefresh]=useState(0), [message,setMessage]=useState('');
  const result=useWorkflowData<{items:WaitingEvent[];hasMore:boolean}>(api,'/order-attention?'+scope,refresh);
  return <section className="records-panel"><h2>Reports waiting for an order</h2>
    {message && <p role="status">{message}</p>}
    {result.error ? <div role="alert"><p>{result.error}</p><button className="records-button secondary" onClick={()=>setRefresh(v=>v+1)}>Try again</button></div>
      : result.loading ? <p role="status">Checking reports…</p>
      : !result.data?.items.length ? <p>No reports are waiting for a reference.</p>
      : result.data.items.map(item=><article key={item.eventKey}>
        <h3>{item.fileName}</h3><p>{displayState(item.kind)} · {displayState(item.entity.type)} {item.entity.id}</p>
        {item.references.length > 0 && <p>{item.references.map(ref=>displayState(ref.type)+' '+ref.id).join(' · ')}</p>}
        <p>{item.reason}</p>
        {canManage && <ChooseOrder api={api} scope={scope} item={item} onSaved={()=>{setMessage('The link was recorded.');setRefresh(v=>v+1);}}/>}
      </article>)}
    {result.data?.hasMore && <p>More reports are waiting. Review these to see the next group.</p>}
  </section>;
}
