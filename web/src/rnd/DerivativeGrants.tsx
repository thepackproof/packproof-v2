import {useEffect,useRef,useState} from 'react';
import type {DerivativeGrant,RndTransport} from './types';
export function DerivativeGrants({proofId,analysisId,artifactSha256,recipeSha256,transport}:{proofId:string;analysisId:string;artifactSha256:string;recipeSha256:string;transport:RndTransport}) {
 const [grants,setGrants]=useState<DerivativeGrant[]>([]),[token,setToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[expiry,setExpiry]=useState(900);const epoch=useRef(0);
 useEffect(()=>{epoch.current++;setGrants([]);setToken('');setError('');setBusy(false);return()=>{epoch.current++;};},[proofId,analysisId,transport]);
 async function action(fn:(current:()=>boolean)=>Promise<void>){const generation=epoch.current,current=()=>generation===epoch.current;setBusy(true);setError('');try{await fn(current);}catch(e){if(current())setError(e instanceof Error?e.message:'Grant operation unavailable.');}finally{if(current())setBusy(false);}}
 if(!transport.grants||!transport.createGrant||!transport.revokeGrant)return null;
 return <details><summary>Scoped derivative access</summary><p>Access covers this reviewed derivative only. The access code is shown once and should be shared privately. Expiration and revocation stop future downloads; downloaded copies cannot be recalled.</p>
  {error&&<p role="alert">{error}</p>}
  <label>Access duration <select value={expiry} onChange={e=>setExpiry(Number(e.target.value))}><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={86400}>24 hours</option></select></label>
  <button disabled={busy||!artifactSha256||!recipeSha256} onClick={()=>void action(async current=>{const value=await transport.createGrant!(proofId,analysisId,{artifactSha256,recipeSha256,expiresInSeconds:expiry},crypto.randomUUID());if(current()){setToken(value.token??'');setGrants(previous=>[...previous.filter(item=>item.grant.id!==value.grant.id),value]);}})}>Create reviewed derivative access</button>
  {token&&<div><label>One-time-displayed access code <input readOnly value={token} autoComplete="off" spellCheck={false} aria-label="Derivative access code"/></label><p>Recipients enter this code on the isolated research web app at <code>/research/derivative</code>. No code is placed in a URL.</p><button onClick={()=>setToken('')}>Hide access code</button></div>}
  <button disabled={busy} onClick={()=>void action(async current=>{const value=await transport.grants!(proofId,analysisId);if(current())setGrants(value.grants);})}>Refresh access grants</button>
  {grants.map(item=><p key={item.grant.id}>{item.grant.id} · expires {item.grant.expiresAt} · {item.revoked?'revoked':item.expired?'expired':'issued'} <button disabled={busy||item.revoked} onClick={()=>void action(async current=>{await transport.revokeGrant!(proofId,item.grant.id);if(current()){setToken('');setGrants(previous=>previous.map(row=>row.grant.id===item.grant.id?{...row,revoked:true}:row));}})}>Revoke this grant</button></p>)}
 </details>;
}
