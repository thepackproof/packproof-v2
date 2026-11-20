import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { recordsPath } from './model';
import { useWorkflowData } from './workflow';

type Order = {proofId:string;orderReference:string};
interface Health {
  incidents:{installationId:string;sourceId:string;generation:number;displayName:string;state:string;
    lastVerifiedReadAt:string|null;nextCheckAt:string|null;affectedOrders:Order[]}[];
  overdue:(Order & {id:string;namespace:string;deadline:string})[];
  limited:boolean;
}
export function OrderSourceHealth({api,scope}: {api:PackProofApi;scope:string}) {
  const [refresh,setRefresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {if (!document.hidden) setRefresh(n=>n+1);},30000);
    return () => clearInterval(timer);
  },[]);
  const result = useWorkflowData<Health>(api,'/order-source-health?' + scope,refresh);
  const params = new URLSearchParams(scope);
  return <section className="records-panel"><h2>Feed checks and overdue receipts</h2>
    <button type="button" className="records-text-button" onClick={()=>setRefresh(n=>n+1)}>Refresh feed checks</button>
    {result.error ? <p role="alert">{result.error}</p> : !result.data ? <p role="status">Checking source reports…</p>
      : !Array.isArray(result.data.incidents) || !Array.isArray(result.data.overdue) ? <p>Source checks are unavailable on this server.</p> : <>
      {!result.data.incidents.length && !result.data.overdue.length && <p>No reported source incident or overdue receipt under the approved timing rules.</p>}
      {result.data.incidents.map(item=><article key={item.installationId + '/' + item.sourceId + '/' + item.generation}>
        <h3>{item.displayName} · {item.state === 'unreadable' ? 'Source could not be read' : 'Source check overdue'}</h3>
        <p>Last successful read · {item.lastVerifiedReadAt ? new Date(item.lastVerifiedReadAt).toLocaleString() : 'Awaiting first read'}</p>
        {item.nextCheckAt && <p>Next check was due · {new Date(item.nextCheckAt).toLocaleString()}</p>}
        {item.affectedOrders.length > 0 && <details><summary>Orders linked to this source ({item.affectedOrders.length})</summary><ul>
          {item.affectedOrders.map(o=><li key={o.proofId}><a href={recordsPath('order-proofs',params,{},o.proofId)}>{o.orderReference}</a></li>)}</ul></details>}
        <p>Check the connection on the collecting computer. A successful read clears the source incident.</p>
      </article>)}
      {result.data.overdue.map(item=><article key={JSON.stringify([item.proofId,item.namespace,item.id,item.deadline])}>
        <h3>Delivery evidence overdue · {item.id}</h3><p>Expected by {new Date(item.deadline).toLocaleString()} on a current feed.</p>
        <a href={recordsPath('order-proofs',params,{subject:item.id,subjectType:'package',namespace:item.namespace},item.proofId)}>Review carton on {item.orderReference}</a>
      </article>)}
      {result.data.limited && <p>Showing a limited set of sources and linked orders. Narrow the location to see more.</p>}
    </>}
  </section>;
}
