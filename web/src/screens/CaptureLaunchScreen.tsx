import {useState} from 'react';
import type {PackProofApi} from '../api/client';
import {beginBrowserEngine,type EngineSession} from '../capture/engine';

/** Capture links contain an opaque token only. A GET never consumes it. */
export function retainCaptureLaunch(){
  if(location.pathname!=='/capture')return;
  const token=new URLSearchParams(location.hash.slice(1)).get('intent');
  if(token&&/^intent_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)){
    sessionStorage.setItem('packproof.capture-launch',token);
    history.replaceState(history.state,'','/capture');
  }
}
export function CaptureLaunchScreen({api,onBound}:{api:PackProofApi;onBound:(session:EngineSession)=>void}){
  const [token]=useState(()=>sessionStorage.getItem('packproof.capture-launch'));
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  async function browser(){if(!token||busy)return;setBusy(true);setError(null);try{
    // Proof identity is read from the server result, never from launch URL fields.
    const session=await beginBrowserEngine(api,undefined,token);
    sessionStorage.removeItem('packproof.capture-launch');onBound(session);
  }catch(e){setError(e instanceof Error?e.message:'This capture link could not be opened.');}finally{setBusy(false);}}
  return <section className="panel stack" style={{maxWidth:560,margin:'2rem auto'}}>
    <h1>Record this order</h1><p>Use your phone camera or continue in this browser. Sign in to the same PackProof account that opened the order.</p>
    {token?<><a className="btn btn-primary" href={`packproof://capture#intent=${encodeURIComponent(token)}`} referrerPolicy="no-referrer">Open PackProof on this phone</a>
      <button className="btn btn-secondary" disabled={busy} onClick={()=>void browser()}>{busy?'Opening the order…':'Record in this browser'}</button></>:<p>This capture link is missing. Open a new recording link from the order.</p>}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
