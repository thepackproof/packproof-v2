import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { CommerceConnectionView } from '../api/types';
import type { IntakeCapabilities, IntakeDevice, MailSetup } from '../intake-types';
import { intakePreferenceKey } from '../intake-types';

export function IntakeSettingsPanel({api,userId,connections}: {api:PackProofApi;userId:string;connections:CommerceConnectionView[]}) {
  const [caps,setCaps]=useState<IntakeCapabilities|null>(null),[devices,setDevices]=useState<IntakeDevice[]>([]),[aliases,setAliases]=useState<MailSetup[]>([]);
  const [deviceId,setDeviceId]=useState(''),[connectionId,setConnectionId]=useState(''),[code,setCode]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=intakePreferenceKey(api.recoveryScope,userId);
  async function refresh() {
    const [d,m]=await Promise.all([api.intakeRequest<{devices:IntakeDevice[]}>('/devices'),api.intakeRequest<{aliases:MailSetup[]}>('/mail')]);
    setDevices(d.devices);setAliases(m.aliases);
  }
  useEffect(()=>{let active=true;if(typeof api.intakeRequest!=='function')return;
    try {const v=JSON.parse(localStorage.getItem(key)||'{}');setDeviceId(v.deviceId||'');setConnectionId(v.connectionId||'');}catch{/* Local preference only. */}
    void api.intakeRequest<IntakeCapabilities>('/capabilities').then(c=>{if(active){setCaps(c);if(c.enabled)void refresh().catch(()=>setError('Connection settings could not be loaded.'));}}).catch(()=>{});
    return()=>{active=false;};
  },[api,userId]);
  async function run(fn:()=>Promise<unknown>) {if(busy)return;setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:'Try again.');}finally{setBusy(false);}}
  function savePreference(next:{deviceId?:string;connectionId?:string}) {
    const value={deviceId:next.deviceId??deviceId,connectionId:next.connectionId??connectionId};
    setDeviceId(value.deviceId);setConnectionId(value.connectionId);
    try{localStorage.setItem(key,JSON.stringify(value));}catch{setError('The default device could not be saved in this browser.');}
  }
  if(!caps?.enabled)return null;
  return <section className="section stack"><h2>Automatic order intake</h2>{error&&<p role="alert" className="banner banner-error">{error}</p>}
    {caps.handoffEnabled&&<><h3>Recording phone</h3><p>Open Connections on your phone, add it as a recording device, then approve its code here.</p>
      <label className="field"><span>Recording device</span><select value={deviceId} onChange={e=>savePreference({deviceId:e.target.value})}><option value="">Choose a device</option>{devices.filter(d=>d.state!=='REVOKED').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="field"><span>Pairing code shown on your phone</span><input autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} maxLength={32}/></label>
      <div className="button-row"><button className="btn" disabled={busy||!deviceId||!code.trim()} onClick={()=>void run(async()=>{await api.intakeRequest(`/devices/${encodeURIComponent(deviceId)}/approve`,'POST',{pairingCode:code.trim()});setCode('');})}>Approve phone</button>
      <button className="btn btn-secondary" disabled={busy||!deviceId} onClick={()=>void run(async()=>{await api.intakeRequest(`/devices/${encodeURIComponent(deviceId)}`,'DELETE');savePreference({deviceId:''});})}>Disconnect phone</button></div></>}
    <label className="field"><span>Store for forwarded orders and browser handoff</span><select value={connectionId} onChange={e=>savePreference({connectionId:e.target.value})}><option value="">Choose the matching connected store</option>{connections.filter(c=>c.status==='ACTIVE').map(c=><option key={c.connectionId} value={c.connectionId}>{c.provider} · {c.externalAccountReference}</option>)}</select></label>
    {caps.emailEnabled&&caps.mailDomainConfigured?<><h3>Order email forwarding</h3><button className="btn btn-secondary" disabled={busy||!connectionId} onClick={()=>void run(()=>api.intakeRequest('/mail','POST',{connectionId}))}>Set up selective forwarding</button>
      {aliases.filter(a=>a.state!=='REVOKED').map(alias=><section className="stack" key={alias.id}><strong>{alias.store}</strong><p>{alias.state==='READY'?'Ready':alias.state==='AWAITING_VALID_SAMPLE'?'Forward one complete sales notification to validate this connection.':'Verify this forwarding address in your email provider.'}</p><code>{alias.address}</code>
        <p>In Gmail, add this forwarding address, complete verification, then create a filter for this store’s sales notifications only. Keep your original messages. Leave all-mail forwarding off.</p>
        {alias.challenge&&Date.parse(alias.challenge.expiresAt)>Date.now()&&<div className="stack">{alias.challenge.code&&<p>Verification code: <strong>{alias.challenge.code}</strong></p>}{alias.challenge.url&&<a href={alias.challenge.url} target="_blank" rel="noopener noreferrer">Open forwarding verification</a>}<button className="btn btn-secondary" disabled={busy} onClick={()=>void run(()=>api.intakeRequest(`/mail/${encodeURIComponent(alias.id)}/verify`,'POST',{challengeId:alias.challenge!.id}))}>I completed provider verification</button></div>}
        {!alias.supportedTemplates.length&&<p>A representative sales email still needs format validation before automatic intake can be activated.</p>}
        {alias.lastErrorCode&&<p role="status">This message needs review. Forward a sales notification that includes the order ID, every item, and quantities.</p>}
        <button className="text-link" disabled={busy} onClick={()=>void run(()=>api.intakeRequest(`/mail/${encodeURIComponent(alias.id)}`,'DELETE'))}>Stop intake at this address</button>
      </section>)}</>:null}
  </section>;
}
