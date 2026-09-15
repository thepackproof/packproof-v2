import { useEffect,useState } from 'react';
import type { PackProofApi } from '../api/client';
type Preferences={enabled:boolean;uploads:boolean;evidence:boolean;participants:boolean;shipments:boolean;returns:boolean};
type Update={id:string;proofId:string;eventId:string;title:string;category:string;createdAt:string;readAt:string|null};
const labels=[['enabled','Proof notifications'],['uploads','Uploads and recovery'],['evidence','Evidence and seals'],['participants','Participant activity'],['shipments','Shipment updates'],['returns','Receipt and returns']] as const;
export function NotificationCenter({api,onOpen}:{api:PackProofApi;onOpen:(id:string)=>void}){
  const [prefs,setPrefs]=useState<Preferences|null>(null),[updates,setUpdates]=useState<Update[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  async function load(){try{const [p,n]=await Promise.all([api.notificationRequest<Preferences>('notification-preferences'),api.notificationRequest<{notifications:Update[]}>('notifications')]);setPrefs(p);setUpdates(n.notifications);setError(null);}catch{setError('Notification settings could not load. Reconnect and retry.');}}
  useEffect(()=>{void load();},[api]);
  return <div className="stack"><p className="note">Preferences apply to your connected Android devices. Your history remains available even when alerts are muted.</p>
    {prefs&&labels.map(([key,label])=><label key={key} className="notification-setting"><span>{label}</span><input type="checkbox" role="switch" checked={prefs[key]} disabled={busy||(key!=='enabled'&&!prefs.enabled)} onChange={event=>{setBusy(true);void api.notificationRequest<Preferences>('notification-preferences','PATCH',{[key]:event.target.checked}).then(setPrefs).catch(()=>setError('This setting was not saved. Try again.')).finally(()=>setBusy(false));}}/></label>)}
    {error&&<p role="alert">{error}</p>}<h3>Notification history</h3><button className="text-link" onClick={()=>void load()}>Refresh</button>
    {!updates.length?<p>No updates yet.</p>:<ol className="notification-history">{updates.map(n=><li key={n.id}><button className="text-link" onClick={()=>{void api.notificationRequest(`notifications/${encodeURIComponent(n.id)}/read`,'POST',{}).catch(()=>undefined);onOpen(n.proofId);}}>{n.title}</button><time dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time></li>)}</ol>}
  </div>;
}
export function ProofNotificationMute({api,proofId}:{api:PackProofApi;proofId:string}){
  const [muted,setMuted]=useState<boolean|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void api.featureRequest<{muted:boolean}>(proofId,'notification-mute').then(r=>{if(active)setMuted(r.muted);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[api,proofId]);
  return <div><label className="notification-setting"><span>Mute this Proof</span><input type="checkbox" role="switch" checked={muted??false} disabled={muted===null||busy} onChange={e=>{setBusy(true);void api.featureRequest<{muted:boolean}>(proofId,'notification-mute','POST',{muted:e.target.checked}).then(r=>setMuted(r.muted)).catch(()=>setError(true)).finally(()=>setBusy(false));}}/></label>{error&&<p role="alert">Notification preference could not load or save. Reopen this Proof to retry.</p>}</div>;
}
