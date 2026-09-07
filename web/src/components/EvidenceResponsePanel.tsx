import { randomId } from "../random-id";
import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
type Supplement = { supplementId:string; proofId:string; sequence:number; kind:string; canonicalJson:string; createdAt:string };
type Intent = { version:1; scope:string; userId:string; proofId:string; operationId:string; text:string; kind:"RECIPIENT_RESPONSE"|"CORRECTION"; phase:"DRAFT"|"SUBMITTING" };
type Props = { api:PackProofApi; proofId:string; userId:string; role:string };
const object = (value:unknown):value is Record<string,unknown> => !!value&&typeof value==='object'&&!Array.isArray(value);
const journalKey = (scope:string,userId:string,proofId:string) => `packproof.statement.v1:${JSON.stringify([scope,userId,proofId])}`;
function facts(entry:Supplement):Record<string,unknown> {try{const parsed:unknown=JSON.parse(entry.canonicalJson);return object(parsed)?parsed:{};}catch{return {};}}
function entry(value:unknown,proofId:string):Supplement {
  if(!object(value)||typeof value.supplementId!=='string'||value.proofId!==proofId||!Number.isSafeInteger(value.sequence)||Number(value.sequence)<1||typeof value.kind!=='string'||typeof value.canonicalJson!=='string'||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw new Error('Statement records are temporarily unavailable.');
  return value as Supplement;
}
function entries(value:unknown,proofId:string):Supplement[] {if(!object(value)||!Array.isArray(value.supplements))throw new Error('Statement records are temporarily unavailable.');return value.supplements.map(value=>entry(value,proofId));}
function isAccepted(item:Supplement,intent:Intent):boolean {const value=facts(item);return value.operationId===intent.operationId&&value.actorUserId===intent.userId&&value.proofId===intent.proofId&&value.kind===intent.kind&&object(value.facts)&&value.facts.statement===intent.text.trim();}
function readIntent(key:string,scope:string,userId:string,proofId:string):Intent|null {
  const raw=localStorage.getItem(key);if(!raw)return null;const parsed:unknown=JSON.parse(raw);
  if(!object(parsed)||parsed.version!==1||parsed.scope!==scope||parsed.userId!==userId||parsed.proofId!==proofId||typeof parsed.operationId!=='string'||!/^[A-Za-z0-9:_-]{8,200}$/.test(parsed.operationId)||typeof parsed.text!=='string'||parsed.text.length>4000||!['CORRECTION','RECIPIENT_RESPONSE'].includes(String(parsed.kind))||!['DRAFT','SUBMITTING'].includes(String(parsed.phase)))throw new Error('The saved statement needs recovery. Contact support before submitting another statement.');
  return parsed as Intent;
}
/** A new account/API/Proof gets a separate component and durable local intent. */
export function EvidenceResponsePanel(props:Props) {return <ScopedResponse key={JSON.stringify([props.api.recoveryScope,props.userId,props.proofId])} {...props}/>;}
function ScopedResponse({api,proofId,userId,role}:Props) {
  const scope=api.recoveryScope,key=journalKey(scope,userId,proofId);
  const [loaded]=useState(()=>{try{return {intent:readIntent(key,scope,userId,proofId),error:null};}catch(error){return {intent:null,error:error instanceof Error?error.message:'Saved statement is unavailable.'};}});
  const [intent,setIntent]=useState<Intent|null>(loaded.intent),intentRef=useRef(intent);
  const [records,setRecords]=useState<Supplement[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(loaded.error),[notice,setNotice]=useState<string|null>(null),[storageError,setStorageError]=useState(!!loaded.error);
  const active=useRef(true),sending=useRef(false);
  const remember=(value:Intent|null)=>{try{
    if(value)localStorage.setItem(key,JSON.stringify(value));
    else {
      const stored=readIntent(key,scope,userId,proofId);
      if(stored&&stored.operationId!==intentRef.current?.operationId){setStorageError(true);setError('A newer statement is saved in another tab. Reload to recover it; the accepted response remains on the Proof.');return false;}
      localStorage.removeItem(key);
    }
    intentRef.current=value;setIntent(value);setStorageError(false);return true;
  }catch{setStorageError(true);setError('This browser could not save your statement for recovery. Keep this page open and free local storage before submitting.');return false;}};
  const accepted=(item:Supplement,pending:Intent)=>{
    if(!isAccepted(item,pending))throw new Error('The statement response could not be confirmed. Retry the same statement shortly.');
    setRecords(old=>[...old.filter(existing=>existing.supplementId!==item.supplementId),item].sort((a,b)=>a.sequence-b.sequence));
    if(remember(null)){setNotice('Statement recorded. Preservation confirmation may still be pending.');setError(null);}
  };
  useEffect(()=>{active.current=true;void api.featureRequest<unknown>(proofId,'supplements').then(result=>{
    if(!active.current)return;const values=entries(result,proofId);setRecords(values);
    const pending=intentRef.current;if(pending?.phase==='SUBMITTING'){const found=values.find(value=>isAccepted(value,pending));if(found)accepted(found,pending);}
  }).catch(()=>{if(active.current)setError('Additional statements are temporarily unavailable. Your saved statement remains available.');});return()=>{active.current=false;};},[api,proofId]);
  function edit(text:string){
    if(intentRef.current?.phase==='SUBMITTING'||sending.current||loaded.error)return;
    try{if(readIntent(key,scope,userId,proofId)?.phase==='SUBMITTING'){setStorageError(true);setError('A statement is awaiting confirmation in another tab. Reload to recover it before editing.');return;}}catch{setStorageError(true);setError('The saved statement is unavailable. Reload before editing.');return;}
    const draft:Intent={version:1,scope,userId,proofId,operationId:randomId(),text,kind:role==='BUYER'?'RECIPIENT_RESPONSE':'CORRECTION',phase:'DRAFT'};
    // Keep typed text visible even if browser storage is full; posting remains disabled.
    intentRef.current=draft;setIntent(draft);setNotice(null);remember(draft);
  }
  async function submit(){
    const pending=intentRef.current;if(sending.current||!pending?.text.trim()||storageError)return;
    try{
      const saved=readIntent(key,scope,userId,proofId);
      if(!saved||saved.operationId!==pending.operationId||saved.text!==pending.text)throw new Error('This statement changed in another tab. Reload to recover the saved version before submitting.');
      const submitted:Intent={...pending,phase:'SUBMITTING'};
      if(!remember(submitted))return;
      sending.current=true;setBusy(true);setError(null);
      const result=await api.featureRequest<unknown>(proofId,'supplements','POST',{operationId:submitted.operationId,kind:submitted.kind,facts:{statement:submitted.text.trim()}});
      if(active.current)accepted(entry(result,proofId),submitted);
    }catch(e){if(active.current)setError(e instanceof Error?e.message:'Your response could not be confirmed. Retry the same statement shortly.');}
    finally{sending.current=false;if(active.current)setBusy(false);}
  }
  return <details className="proof-supporting-tools"><summary>Responses and corrections</summary><div className="stack">
    <p>Add an attributed statement to this Proof. Existing recordings, statements and the finalized record remain unchanged.</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {records.map(item=>{const value=facts(item),source=object(value.facts)?value.facts:{};return <article key={item.supplementId}><strong>{item.kind==='RECIPIENT_RESPONSE'?'Recipient response':item.kind==='CORRECTION'?'Correction':'Record update'} · {item.sequence}</strong><p>{typeof source.statement==='string'?source.statement:'Source facts are available in the integrity record.'}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></article>;})}
    {intent?.phase==='SUBMITTING'&&<p role="status">This statement is awaiting confirmation. Retry uses the same saved statement and cannot create a second response.</p>}
    <label className="field"><span>{role==='BUYER'?'Your response':'Your correction or additional context'}</span><textarea maxLength={4000} value={intent?.text??''} readOnly={intent?.phase==='SUBMITTING'||!!loaded.error} onChange={e=>edit(e.target.value)}/></label>
    <button className="btn btn-secondary" disabled={busy||storageError||!intent?.text.trim()} onClick={()=>void submit()}>{busy?'Recording statement…':intent?.phase==='SUBMITTING'?'Retry saved statement':'Add statement to Proof'}</button>
  </div></details>;
}
