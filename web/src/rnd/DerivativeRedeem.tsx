import {useMemo,useState} from 'react';
import {PackProofApi} from '../api/client';
import {defaultApiBaseUrl} from '../auth/session';
import './rnd.css';
/** Public grant redemption is still confined to the research API's loopback origin. */
export function DerivativeRedeem() {
 const api=useMemo(()=>new PackProofApi({baseUrl:defaultApiBaseUrl(),getToken:()=>null}),[]);
 const [token,setToken]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 return <main className="rnd-panel" style={{maxWidth:720,margin:'48px auto'}}><span className="rnd-eyebrow">EXPERIMENTAL R&D</span><h1>Download a reviewed derivative</h1><p>Enter the private access code you received. This access includes the reviewed redacted file and its signed transformation record. Originals and source-dependent private observations are omitted.</p><form onSubmit={event=>{event.preventDefault();if(busy||!/^rndg_[A-Za-z0-9_-]{43}$/.test(token))return;setBusy(true);setMessage('');void api.rndRedeemGrant(token).then(blob=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='PackProof-Reviewed-Derivative.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setToken('');setMessage('Reviewed derivative archive downloaded.');}).catch(e=>setMessage(e instanceof Error?e.message:'Access is unavailable.')).finally(()=>setBusy(false));}}><label>Private access code <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value.trim())} maxLength={48}/></label><button disabled={busy||!/^rndg_[A-Za-z0-9_-]{43}$/.test(token)}>{busy?'Downloading…':'Download reviewed archive'}</button></form>{message&&<p role="status">{message}</p>}<p className="rnd-limits">The code is sent in the request body, not a URL. The issuer can revoke access, but cannot recall an already downloaded file. A valid signature does not certify the scene or the completeness of redaction.</p></main>;
}
