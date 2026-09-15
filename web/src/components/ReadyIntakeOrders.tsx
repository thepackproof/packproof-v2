import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { IntakeCapabilities, IntakeOrder, IntakeSnapshot } from '../intake-types';
import { intakePreferenceKey } from '../intake-types';
import { randomId } from '../random-id';
import {IntakeResolution} from './IntakeResolution';

export function ReadyIntakeOrders({api,userId,onRecord}: {
  api: PackProofApi; userId: string; onRecord: (snapshot: IntakeSnapshot) => void;
}) {
  const [orders,setOrders]=useState<IntakeOrder[]>([]);
  const [caps,setCaps]=useState<IntakeCapabilities|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const [notice,setNotice]=useState('');
  const keys=useRef(new Map<string,string>());
  const [target,setTarget]=useState('');
  const [resolving,setResolving]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    if(typeof api.intakeRequest!=='function')return;
    try { setTarget(JSON.parse(localStorage.getItem(intakePreferenceKey(api.recoveryScope,userId))||'{}').deviceId||''); } catch { setTarget(''); }
    void api.intakeRequest<IntakeCapabilities>('/capabilities').then(value=>{if(active)setCaps(value);return api.intakeRequest<{orders:IntakeOrder[]}>('/orders');})
      .then(value=>{if(active&&Array.isArray(value?.orders))setOrders(value.orders);}).catch(()=>{/* Old API remains compatible. */});
    return ()=>{active=false;};
  },[api,userId]);
  async function send(snapshot:IntakeSnapshot) {
    if(busy)return;
    setBusy(snapshot.id);setError('');setNotice('');
    let key=keys.current.get(snapshot.id)||randomId();keys.current.set(snapshot.id,key);
    try {
      const sendRequest=()=>api.intakeRequest<{handoff:{state:string}}>('/handoffs','POST',{snapshotId:snapshot.id,targetDeviceId:target,idempotencyKey:key});
      let result=await sendRequest();
      if(result?.handoff?.state==='EXPIRED'){key=randomId();keys.current.set(snapshot.id,key);result=await sendRequest();}
      if(result?.handoff?.state==='REVOKED')throw new Error('This recording phone has been disconnected. Pair it again in Settings.');
      if(result?.handoff?.state==='EXPIRED')throw new Error('The phone prompt expired. Try sending this order again.');
      if(!['PENDING','CLAIMED'].includes(result?.handoff?.state))throw new Error('The recording phone did not confirm this handoff. Try again.');
      setNotice(result.handoff.state==='CLAIMED'?'This order has already been accepted on your recording phone.':'Order ready; open PackProof on your recording phone.');
    } catch(e) {setError(e instanceof Error?e.message:'This order could not be sent. Try again.');}
    finally {setBusy(null);}
  }
  if(!orders.length)return null;
  return <section className="section stack" aria-label="Ready orders">
    <h2>Ready to pack</h2>
    {notice&&<p role="status">{notice}</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}
    {orders.map(order=><article className="section stack" key={order.observationId}>
      {order.snapshot?<><strong>{order.snapshot.orderReference}</strong><span className="meta">{order.snapshot.store}</span>
        <ul>{order.snapshot.items.map((item,i)=><li key={i}>{item.title}{item.variant?` · ${item.variant}`:''} · Quantity {item.quantity}</li>)}</ul></>:<strong>Order needs information</strong>}
      {order.readiness==='READY'&&order.snapshot?<div className="button-row">
        <button className="btn" disabled={busy!==null} onClick={()=>onRecord(order.snapshot!)}>Record packing</button>
        {caps?.handoffEnabled&&target&&<button className="btn btn-secondary" disabled={busy!==null} onClick={()=>void send(order.snapshot!)}>{busy===order.snapshot.id?'Sending…':'Record on phone'}</button>}
      </div>:<><p>{order.reasons.some(r=>r.includes('CONFLICT')||r.includes('CHANGED'))?'The source differs from the prepared order. Review it before recording.':'The source does not yet establish every purchased item, quantity, and fulfillment detail.'}</p><button className="btn btn-secondary" onClick={()=>setResolving(order.observationId)}>Resolve</button></>}
      {resolving===order.observationId&&<IntakeResolution api={api} observationId={order.observationId} onCancel={()=>setResolving(null)} onDone={()=>{setResolving(null);void api.intakeRequest<{orders:IntakeOrder[]}>('/orders').then(v=>{if(Array.isArray(v?.orders))setOrders(v.orders);}).catch(()=>setError('Refresh prepared orders to see the correction.'));}}/>}
    </article>)}
  </section>;
}
