import {useEffect,useRef,useState} from 'react';
import type {PackProofApi} from '../api/client';
type Invoice={invoiceReference:string;status:string;currency:'USD';amountDueMinor:number;amountPaidMinor:number;createdAt:string};
type Page={enabled:boolean;invoices:Invoice[];environment?:'sandbox'|'live';hasMore?:boolean;nextStartingAfter?:string|null};
function page(value:unknown):Page{
  const p=value as Page;
  if(!p||typeof p.enabled!=='boolean'||!Array.isArray(p.invoices)||p.invoices.length>100)throw new Error('Invalid invoice response');
  if(!p.enabled)return {enabled:false,invoices:[]};
  if(!['sandbox','live'].includes(p.environment??'')||typeof p.hasMore!=='boolean'||p.hasMore&&typeof p.nextStartingAfter!=='string')throw new Error('Invalid invoice response');
  for(const row of p.invoices)if(!row||!/^in_[A-Za-z0-9]{1,180}$/.test(row.invoiceReference)||!['draft','open','paid','uncollectible','void','unknown'].includes(row.status)||row.currency!=='USD'||![row.amountDueMinor,row.amountPaidMinor].every(v=>Number.isSafeInteger(v)&&v>=0)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw new Error('Invalid invoice response');
  return p;
}
export function BillingPanel(props:{api:PackProofApi;userId:string}){return <ScopedBilling key={JSON.stringify([props.api.recoveryScope,props.userId])} {...props}/>;}
function ScopedBilling({api}:{api:PackProofApi;userId:string}){
  const [data,setData]=useState<Page|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  const current=useRef(true);
  useEffect(()=>{current.current=true;let active=true;
    void api.getBillingInvoices<unknown>().then(value=>{const result=page(value);if(active)setData(result);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;current.current=false;};
  },[api]);
  if(data?.enabled===false)return null;
  const loadMore=async()=>{if(busy||!data?.nextStartingAfter)return;setBusy(true);setError(false);try{
    const result=page(await api.getBillingInvoices<unknown>(data.nextStartingAfter));
    if(current.current)setData(previous=>({...result,invoices:[...new Map([...(previous?.invoices??[]),...result.invoices].map(row=>[row.invoiceReference,row])).values()]}));
  }catch{if(current.current)setError(true);}finally{if(current.current)setBusy(false);}};
  const amount=(minor:number)=>(minor/100).toLocaleString(undefined,{style:'currency',currency:'USD'});
  return <section className="page"><details><summary>Billing invoices</summary>
    {error&&<p role="status">Invoices are temporarily unavailable. Your saved Proofs remain accessible.</p>}
    {!data&&!error&&<p>Loading invoices…</p>}
    {data?.enabled&&<div className="stack">
      {data.environment==='sandbox'&&<p className="note">Test billing records. These are not live charges.</p>}
      {!data.invoices.length?<p>No invoices are available for this billing account.</p>:<table><caption>Invoices for this account</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col">Invoice amount due</th><th scope="col">Paid</th></tr></thead><tbody>{data.invoices.map(row=><tr key={row.invoiceReference}><th scope="row">{row.invoiceReference}</th><td>{new Date(row.createdAt).toLocaleDateString()}</td><td>{row.status}</td><td>{amount(row.amountDueMinor)}</td><td>{amount(row.amountPaidMinor)}</td></tr>)}</tbody></table>}
      {data.hasMore&&<button className="btn btn-secondary" disabled={busy} onClick={()=>void loadMore()}>{busy?'Loading…':'Load older invoices'}</button>}
      <p className="note">Invoice status comes from your billing provider. Viewing this page creates no charge. Your plan version and recorded Proof units appear under Proof usage.</p>
    </div>}
  </details></section>;
}
