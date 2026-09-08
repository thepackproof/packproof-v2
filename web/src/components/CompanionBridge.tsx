import {useEffect,useState} from 'react';
import type {PackProofApi} from '../api/client';
import type {CommerceConnectionView} from '../api/types';
import type {IntakeCapabilities,IntakeOrder} from '../intake-types';
import {intakePreferenceKey} from '../intake-types';
type Reply={ok:boolean;adapterValidated?:boolean;events?:Array<{eventId:string;ownerId:string;connectionId:string}>;reason?:string};
type Runtime={sendMessage:(id:string,message:unknown,callback:(result:Reply)=>void)=>void;lastError?:{message?:string}};
function send(runtime:Runtime,id:string,message:unknown):Promise<Reply>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('The browser companion did not respond.')),5000);
  runtime.sendMessage(id,message,value=>{clearTimeout(timer);if(runtime.lastError||!value?.ok)reject(new Error('Reconnect the browser companion from its toolbar button.'));else resolve(value);});
});}
/** App-owned authentication stays inside PackProof; marketplace scripts never receive it. */
export function CompanionBridge({api,userId,connections}:{api:PackProofApi;userId:string;connections:CommerceConnectionView[]}){
  const [notice,setNotice]=useState('');
  const companion=new URLSearchParams(window.location.search).get('companion');
  useEffect(()=>{
    if(!companion||!/^[a-p]{32}$/.test(companion))return;
    const runtime=(window as unknown as {chrome?:{runtime?:Runtime}}).chrome?.runtime;
    if(!runtime){setNotice('Open the browser companion in a supported desktop browser.');return;}
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined,failures=0;
    const started=Date.now();
    const tick=async()=>{
      if(!alive||Date.now()-started>5*60_000)return;
      try{
        const preferences=JSON.parse(localStorage.getItem(intakePreferenceKey(api.recoveryScope,userId))||'{}');
        const connection=connections.find(c=>c.connectionId===preferences.connectionId&&c.status==='ACTIVE');
        if(!connection||!preferences.deviceId){setNotice('Choose this store and your recording phone in Connections, then reopen the companion.');return;}
        const config=await send(runtime,companion,{type:'PACKPROOF_COMPANION_CONFIGURE',ownerId:userId,connectionId:connection.connectionId,accountReference:connection.externalAccountReference});
        const caps=await api.intakeRequest<IntakeCapabilities>('/capabilities');
        if(!config.adapterValidated||!caps.browserEnabled){if(alive)setNotice('The browser companion is waiting for its supported order page to be validated.');return;}
        const batch=await send(runtime,companion,{type:'PACKPROOF_COMPANION_PULL',ownerId:userId});
        for(const event of batch.events||[]){
          if(!alive)return;
          if(event.ownerId!==userId||event.connectionId!==connection.connectionId)throw new Error('This order belongs to another store. Review Connections.');
          const order=await api.intakeRequest<IntakeOrder>('/observations','POST',event);
          if(!alive)return;
          if(order.readiness==='READY'&&order.snapshot){
            await api.intakeRequest('/handoffs','POST',{snapshotId:order.snapshot.id,targetDeviceId:preferences.deviceId,idempotencyKey:`browser:${event.eventId}`,eventId:event.eventId});
            if(alive)setNotice('Order ready; open PackProof on your recording phone.');
          }else if(alive)setNotice('The selected order needs information. Review it in New Proof.');
          if(!alive)return;
          await send(runtime,companion,{type:'PACKPROOF_COMPANION_ACK',ownerId:userId,eventId:event.eventId});
        }
        failures=0;
      }catch(error){failures++;if(alive)setNotice(error instanceof Error?error.message:'The order remains queued. Reconnect to continue.');}
      if(alive)timer=setTimeout(()=>void tick(),Math.min(30_000,2000*2**Math.min(failures,4)));
    };
    void tick();return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[api,userId,companion,connections]);
  return notice?<p className="banner" role="status">{notice} <a href="/stores">Connections</a></p>:null;
}
