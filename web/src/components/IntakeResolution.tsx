import {useEffect,useRef,useState} from 'react';
import type {PackProofApi} from '../api/client';
import {randomId} from '../random-id';
type Details={items:Array<{title:string|null;quantity:number|null;variant?:string|null}>;physicalFulfillment:boolean|null;paid:boolean|null;fulfillmentScope:string;orderReference:string|null};
export function IntakeResolution({api,observationId,onDone,onCancel}:{api:PackProofApi;observationId:string;onDone:()=>void;onCancel:()=>void}){
  const [details,setDetails]=useState<Details|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const key=useRef(randomId());
  useEffect(()=>{let alive=true;void api.intakeRequest<Details>(`/observations/${encodeURIComponent(observationId)}`).then(value=>{if(alive)setDetails(value);}).catch(()=>setError('The order details could not be loaded.'));return()=>{alive=false;};},[api,observationId]);
  async function save(){if(!details||busy)return;setBusy(true);setError('');try{await api.intakeRequest(`/observations/${encodeURIComponent(observationId)}/resolve`,'POST',{...details,receiptId:key.current,reason});onDone();}catch(e){setError(e instanceof Error?e.message:'The correction could not be saved.');}finally{setBusy(false);}}
  return <section className="stack" aria-label="Resolve order"><h3>Complete this order</h3><p>Enter only facts you can confirm from the sale. Your correction will be kept with the original source.</p>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}
    {details&&<><strong>{details.orderReference}</strong>{details.items.map((item,i)=><fieldset key={i}><legend>Item {i+1}</legend>
      <label className="field"><span>Purchased item</span><input value={item.title||''} maxLength={2000} onChange={e=>setDetails({...details,items:details.items.map((v,j)=>j===i?{...v,title:e.target.value}:v)})}/></label>
      <label className="field"><span>Quantity</span><input type="number" min="1" step="1" value={item.quantity??''} onChange={e=>setDetails({...details,items:details.items.map((v,j)=>j===i?{...v,quantity:e.target.value?Number(e.target.value):null}:v)})}/></label>
      <label className="field"><span>Variant, if stated</span><input value={item.variant||''} maxLength={1000} onChange={e=>setDetails({...details,items:details.items.map((v,j)=>j===i?{...v,variant:e.target.value||null}:v)})}/></label></fieldset>)}
      <button className="text-link" onClick={()=>setDetails({...details,items:[...details.items,{title:null,quantity:null}]})}>Add purchased item</button>
      <label className="field"><span>Payment</span><select value={details.paid===null?'':String(details.paid)} onChange={e=>setDetails({...details,paid:e.target.value===''?null:e.target.value==='true'})}><option value="">Not known</option><option value="true">Paid</option><option value="false">Not paid</option></select></label>
      <label className="field"><span>Fulfillment</span><select value={details.physicalFulfillment===null?'':String(details.physicalFulfillment)} onChange={e=>setDetails({...details,physicalFulfillment:e.target.value===''?null:e.target.value==='true'})}><option value="">Not known</option><option value="true">Physical items being shipped</option><option value="false">Digital or non-shipping order</option></select></label>
      <label className="field"><span>What this package contains</span><select value={details.fulfillmentScope} onChange={e=>setDetails({...details,fulfillmentScope:e.target.value})}><option value="UNKNOWN">Not yet confirmed</option><option value="FULL_ORDER">The full order in one package</option><option value="PARTIAL">Part of the order</option><option value="MULTI_PARCEL">Multiple packages</option></select></label>
      <label className="field"><span>Reason for this correction</span><input value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
      <button className="btn" disabled={busy||!reason.trim()} onClick={()=>void save()}>{busy?'Saving…':'Save order context'}</button></>}
    <button className="btn btn-secondary" disabled={busy} onClick={onCancel}>Close</button>
  </section>;
}
