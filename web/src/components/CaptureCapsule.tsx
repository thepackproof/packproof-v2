import {useEffect,useState} from 'react';
import type {PackProofApi} from '../api/client';
import type {EvidenceEvent,CapabilitySnapshot,Requirement} from '../../../backend/src/capture/core';
type Capsule={captureId:string;evidenceId:string;sha256:string;events:EvidenceEvent[];capabilities:CapabilitySnapshot;requirements:Requirement[];assurance:string};
export function CaptureCapsule({api,proofId,onSeek}:{api:PackProofApi;proofId:string;onSeek:(id:string,seconds:number)=>void}){
 const [captures,setCaptures]=useState<Capsule[]>([]);
 useEffect(()=>{let active=true;setCaptures([]);void api.featureRequest<{captures:Capsule[]}>(proofId,'capture-capsule').then(r=>{if(active&&Array.isArray(r.captures))setCaptures(r.captures);}).catch(()=>undefined);return()=>{active=false;};},[api,proofId]);
 if(!captures.length)return null;
 return <section aria-label="Capture timeline" className="record-chapters stack"><h3>Capture timeline</h3>{captures.map(c=><div key={c.captureId} className="stack">
   <div className="record-chapters">{c.events.map(e=><button key={e.id} type="button" onClick={()=>onSeek(c.evidenceId,e.startMs/1000)}>{Math.floor(e.startMs/60000)}:{String(Math.floor(e.startMs/1000)%60).padStart(2,'0')} · {e.description}</button>)}</div>
   <details><summary>Capture details</summary><p>{c.assurance}</p><p>Camera source: {c.capabilities.cameraSource.toLowerCase()}. Device origin: {c.capabilities.appIntegrity==='UNAVAILABLE'?'not independently attested':'client assertion only'}. Audio: {c.capabilities.audio?'included':'off'}.</p>{c.requirements.filter(r=>r.state==='UNAVAILABLE').map(r=><p key={r.type}>{r.type==='ITEM_VISIBLE'?'Item recognition':'This signal'} was unavailable on this capture surface.</p>)}</details>
 </div>)}</section>;
}
