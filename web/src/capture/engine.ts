import {canonical,chainSegment,createManifest,manifestDigest,CORE_VERSION,type CapabilitySnapshot,type CaptureContext,type MediaSegment,type Observation} from '../../../backend/src/capture/core';
import type {PackProofApi} from '../api/client';
import type {PendingStationCapture} from '../capture-queue';
export const captureEngineEnabled=()=>import.meta.env.VITE_PACKPROOF_CAPTURE_ENGINE==='1';
const hex=(v:ArrayBuffer)=>Array.from(new Uint8Array(v),b=>b.toString(16).padStart(2,'0')).join('');
const bytesHash=async(value:Blob)=>hex(await crypto.subtle.digest('SHA-256',await value.arrayBuffer()));
const hash=async(value:string)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
export type EngineSession={id:string;state:string;context:CaptureContext};
type Record={key:string;apiScope:string;userId:string;context:CaptureContext;segments:MediaSegment[];observations:Observation[];metadata:Omit<PendingStationCapture,'file'>;finished:boolean;};
const open=()=>new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('packproof-capture-engine',1);r.onupgradeneeded=()=>{r.result.createObjectStore('sessions',{keyPath:'key'});r.result.createObjectStore('chunks',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Browser storage is unavailable.'));});
async function read<T>(store:string,key?:string):Promise<T>{const db=await open();try{return await new Promise((resolve,reject)=>{const t=db.transaction(store,'readonly'),r=key===undefined?t.objectStore(store).getAll():t.objectStore(store).get(key);t.oncomplete=()=>resolve(r.result as T);t.onerror=()=>reject(t.error);});}finally{db.close();}}
async function write(record:Record,chunk?:{key:string;blob:Blob},create=false){
  const db=await open();
  try {
    await new Promise<void>((resolve,reject)=>{
      const transaction=db.transaction(['sessions','chunks'],'readwrite');
      if(create)transaction.objectStore('sessions').add(record);
      else transaction.objectStore('sessions').put(record);
      if(chunk)transaction.objectStore('chunks').add(chunk);
      transaction.oncomplete=()=>resolve();
      transaction.onabort=transaction.onerror=event=>{
        const cause=transaction.error??(event.target as IDBRequest)?.error;
        const exists=cause?.name==='ConstraintError';
        reject(Object.assign(new Error(exists?'A recording already exists. Recover it from its original order.':'Free browser storage before continuing. Your committed chunks are kept.'),{code:exists?'CAPTURE_JOURNAL_EXISTS':'CAPTURE_STORAGE_FAILED'}));
      };
    });
  } finally {db.close();}
}

const keyFor=(scope:string,userId:string,captureId:string)=>canonical([scope,userId,captureId]);
export async function beginBrowserEngine(api:PackProofApi,proofId:string|undefined,launchToken?:string):Promise<EngineSession> {
  if(!isSecureContext||!crypto.subtle||!indexedDB)throw new Error('Use a secure camera browser with local storage.');
  const estimate=await navigator.storage?.estimate?.();const reserve=Math.max(0,Math.floor((estimate?.quota??0)-(estimate?.usage??0)));
  if(estimate?.quota&&reserve<64*1024*1024)throw new Error('Free browser storage before recording.');
  const capabilities:CapabilitySnapshot={surface:'WEB',cameraSource:'UNKNOWN',timing:'MONOTONIC',barcode:typeof (globalThis as {BarcodeDetector?:unknown}).BarcodeDetector==='function',itemVisibility:false,durableJournal:true,incrementalMedia:true,audio:false,deviceAuthentication:'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:reserve,coreVersion:CORE_VERSION};
  const intent=launchToken?{launchToken}:await api.captureEngineRequest<{launchToken:string}>('/capture-intents','POST',{proofId,allowedSurfaces:['WEB']});
  const bound=await api.captureEngineRequest<{session:{id:string;state:string};context:CaptureContext}>('/capture-sessions/bind','POST',{launchToken:intent.launchToken,capabilities}).catch(error=>{
    if(error?.status!==undefined&&error?.code!=='CAPTURE_INTENT_USED')throw error;
    return api.captureEngineRequest<{session:{id:string;state:string};context:CaptureContext}>(`/capture-intents/${encodeURIComponent(intent.launchToken.split('.')[0])}/context`);
  });
  if(bound.session.state!=='ISSUED'||canonical({...bound.context.capabilities,storageReserveBytes:0})!==canonical({...capabilities,storageReserveBytes:0}))throw new Error('Recover this recording on its original device, or open a new capture link.');
  if((proofId!==undefined&&bound.context.proofId!==proofId)||bound.context.captureId!==bound.session.id)throw new Error('This capture link belongs to another order.');
  return {...bound.session,context:bound.context};
}
export class BrowserCaptureJournal {
  private serial:Promise<void>=Promise.resolve();private error:unknown=null;private record:Record;
  constructor(apiScope:string,userId:string,context:CaptureContext,metadata:Omit<PendingStationCapture,'file'>){
    if(context.actorId!==userId||context.proofId!==metadata.order.proofId)throw new Error('Capture account or order mismatch.');
    this.record={key:keyFor(apiScope,userId,context.captureId),apiScope,userId,context,metadata,segments:[],observations:[],finished:false};
  }
  async start(){await write(this.record,undefined,true);}
  append(blob:Blob,timeMs:number){
    this.serial=this.serial.then(async()=>{
      if(this.error)throw this.error;
      const last=this.record.segments.at(-1);const segment=await chainSegment({sequence:this.record.segments.length,offsetBytes:(last?.offsetBytes??0)+(last?.byteSize??0),byteSize:blob.size,sha256:await bytesHash(blob),previous:last?.commitment??null,startMs:last?.endMs??0,endMs:Math.min(300000,Math.max(last?.endMs??0,Math.floor(timeMs))),timing:'CHUNK_ARRIVAL_APPROXIMATE'},hash);
      // The blob and its commitment become durable in the same IndexedDB transaction.
      const updated={...this.record,segments:[...this.record.segments,segment]};await write(updated,{key:`${this.record.key}:${segment.sequence}`,blob});this.record=updated;
    }).catch(e=>{this.error=e;});
  }
  recordScans(scans:NonNullable<PendingStationCapture['shippingScans']>){
    this.serial=this.serial.then(async()=>{
      if(this.error)throw this.error;
      const updated={...this.record,metadata:{...this.record.metadata,shippingScans:scans.map(s=>({...s,rawValue:s.rawValue.replace(/[\s-]/g,'').toUpperCase()}))}};
      await write(updated);this.record=updated;
    }).catch(e=>{this.error=e;});
  }
  async flush(){await this.serial;if(this.error)throw this.error;}
  async finish(){await this.flush();this.record={...this.record,finished:true};await write(this.record);}
}
export async function recoverBrowserEngine(userId:string,apiScope:string):Promise<PendingStationCapture|null>{
  const records=await read<Record[]>('sessions');const record=records.filter(r=>r.userId===userId&&r.apiScope===apiScope&&r.segments.length>0).at(-1);if(!record)return null;
  const chunks:Blob[]=[];
  for(const segment of record.segments){const row=await read<{blob:Blob}>('chunks',`${record.key}:${segment.sequence}`);if(!row?.blob||await bytesHash(row.blob)!==segment.sha256)throw new Error('A saved media chunk failed its integrity check. Keep this browser’s original data.');chunks.push(row.blob);}
  return {...record.metadata,captureContext:record.context,file:new Blob(chunks,{type:chunks[0].type}),durationMs:record.segments.at(-1)!.endMs,interrupted:!record.finished,finishConfirmed:false};
}
export async function sealBrowserEngine(api:PackProofApi,pending:PendingStationCapture):Promise<void>{
  const context=pending.captureContext;if(!context)return;
  if(context.actorId!==pending.userId||context.proofId!==pending.order.proofId||context.captureId!==pending.captureSessionId||pending.apiScope!==api.recoveryScope)throw new Error('Open this recording in its original account and order.');
  const record=await read<Record>('sessions',keyFor(api.recoveryScope,pending.userId!,context.captureId));if(!record)throw new Error('The original capture journal is unavailable.');
  if(!pending.digest||!pending.durationMs)throw new Error('Preserve the recording before sealing it.');
  const durationMs=Math.min(300000,Math.floor(pending.durationMs));
  const device=(type:'CAPTURE_STARTED'|'CAPTURE_ENDED'|'INTERRUPTION',time:number):Observation=>({id:type,captureId:context.captureId,type,startMs:time,endMs:time,source:'DEVICE',model:null,confidence:null,value:type==='INTERRUPTION'?'PROCESS_RESTART':null,timePrecision:'APPROXIMATE'});
  const labels:Observation[]=(pending.shippingScans??[]).filter(s=>/^[A-Z0-9]{10,64}$/.test(s.rawValue.replace(/[\s-]/g,'').toUpperCase())).map((s,i)=>({id:`label:${i}`,captureId:context.captureId,type:'LABEL',startMs:Math.min(durationMs,Math.floor(s.detectedAtMs)),endMs:Math.min(durationMs,Math.floor(s.detectedAtMs)),source:'LIVE_ANALYSIS',model:{id:'browser-barcode',version:'browser-api/1',configuration:'tracking-3-frame-consensus',calibration:'NOT_CALIBRATED'},confidence:null,value:s.rawValue.replace(/[\s-]/g,'').toUpperCase(),timePrecision:'APPROXIMATE'}));
  const observations=[device('CAPTURE_STARTED',0),...labels.sort((a,b)=>a.startMs-b.startMs),...(pending.interrupted?[device('INTERRUPTION',durationMs)]:[]),device('CAPTURE_ENDED',durationMs)];
  const source={sha256:pending.digest,byteSize:pending.file.size,contentType:pending.file.type.split(';')[0],durationMs};
  const manifest=await createManifest(context,source,record.segments,observations,hash);const digest=await manifestDigest(manifest,hash);
  await api.captureEngineRequest(`/capture-sessions/${encodeURIComponent(context.captureId)}/seal`,'POST',{source,segments:manifest.segments,observations,sha256:digest});
}
export async function forgetBrowserEngine(scope:string,userId:string,captureId:string){const key=keyFor(scope,userId,captureId),record=await read<Record>('sessions',key);if(!record)return;const db=await open();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['sessions','chunks'],'readwrite');tx.objectStore('sessions').delete(key);for(const s of record.segments)tx.objectStore('chunks').delete(`${key}:${s.sequence}`);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
