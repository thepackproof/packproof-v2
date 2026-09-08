import {useEffect,useRef,useState} from 'react';
import type {PackProofApi} from '../api/client';
import type {IntakeCapabilities,IntakeOrder} from '../intake-types';
import {intakePreferenceKey} from '../intake-types';
import {randomId} from '../random-id';
export function SelectedOrderHandoff({api,userId,transactionId}:{api:PackProofApi;userId:string;transactionId:string}){
  const [target,setTarget]=useState(''),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const key=useRef(randomId());
  useEffect(()=>{let alive=true;if(typeof api.intakeRequest!=='function')return;
    try{setTarget(JSON.parse(localStorage.getItem(intakePreferenceKey(api.recoveryScope,userId))||'{}').deviceId||'');}catch{}
    void api.intakeRequest<IntakeCapabilities>('/capabilities').then(c=>{if(alive)setEnabled(c.handoffEnabled);}).catch(()=>{});return()=>{alive=false;};
  },[api,userId]);
  if(!enabled||!target)return null;
  async function handoff(){if(busy)return;setBusy(true);setNotice('');try{
    const order=await api.intakeRequest<IntakeOrder>('/orders/prepare','POST',{transactionId});
    if(order.readiness!=='READY'||!order.snapshot)throw new Error('This order needs complete purchased-item and fulfillment details. Review it in New Proof.');
    const sendRequest=()=>api.intakeRequest<{handoff:{state:string}}>('/handoffs','POST',{snapshotId:order.snapshot!.id,targetDeviceId:target,idempotencyKey:key.current});
    let result=await sendRequest();
    if(result?.handoff?.state==='EXPIRED'){key.current=randomId();result=await sendRequest();}
    if(result?.handoff?.state==='REVOKED')throw new Error('This recording phone has been disconnected. Pair it again in Settings.');
    if(result?.handoff?.state==='EXPIRED')throw new Error('The phone prompt expired. Try sending this order again.');
    if(!['PENDING','CLAIMED'].includes(result?.handoff?.state))throw new Error('The recording phone did not confirm this handoff. Try again.');
    setNotice(result.handoff.state==='CLAIMED'?'This order has already been accepted on your recording phone.':'Order ready; open PackProof on your recording phone.');
  }catch(e){setNotice(e instanceof Error?e.message:'The order could not be sent. Try again.');}finally{setBusy(false);}}
  return <section className="section"><button className="btn btn-secondary" disabled={busy} onClick={()=>void handoff()}>{busy?'Sending…':'Record on phone'}</button>{notice&&<p role="status">{notice}</p>}</section>;
}
