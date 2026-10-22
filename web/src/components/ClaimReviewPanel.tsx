import {useEffect,useRef,useState} from 'react';
import type {PackProofApi} from '../api/client';
import {randomId} from '../random-id';
import {RecipientExportPanel} from './RecipientExportPanel';

type Facts={reasonCode:string;network:string;lifecycleStatus:string;providerDeadline:string|null;retrievedAt:string;allowedActions:string[]};
type Claim={claimCaseId:string;snapshotSha256:string;revision:number;preservation:{status:string};snapshot:Facts&{proofId:string;claimCaseId:string;providerAccountId:string;integrationAccountId:string;disputeId:string;paymentId:string;orderLineIds:string[];source:'MERCHANT_REPORTED';providerVerification:'UNVERIFIED';apiVersion:'MANUAL_PORTAL';region:'US';paymentMethod:'CARD'}};
type Options={proofId:string;payments:Array<{integrationAccountId:string;providerAccountId:string;paymentId:string}>;orderLines:Array<{id:string;title:string|null;quantity:number|null}>};
const object=(v:unknown):v is Record<string,any>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const states=['needs_response','warning_needs_response','under_review','warning_under_review','won','lost','warning_closed','prevented'];
const networks=['MASTERCARD','VISA','AMEX','DISCOVER','OTHER','UNKNOWN'];
function claimFrom(v:unknown,proofId:string):Claim{
 const bad=()=>new Error('Case details could not be verified. Reload cases before continuing.');
 if(!object(v)||!text(v.claimCaseId)||!/^[a-f0-9]{64}$/.test(String(v.snapshotSha256))||!Number.isInteger(v.revision)||v.revision<1||!object(v.snapshot)||!object(v.preservation)||!['PRESERVED','COMMITTED_PENDING_DURABILITY','FAILED','LEGACY_UNCONFIRMED'].includes(v.preservation.status))throw bad();
 const s=v.snapshot;
 if(s.proofId!==proofId||s.claimCaseId!==v.claimCaseId||s.revision!==v.revision||s.provider!=='stripe'||s.region!=='US'||s.paymentMethod!=='CARD'||s.source!=='MERCHANT_REPORTED'||s.providerVerification!=='UNVERIFIED'||s.apiVersion!=='MANUAL_PORTAL'||
  !['providerAccountId','integrationAccountId','disputeId','paymentId','reasonCode'].every(k=>text(s[k]))||!networks.includes(s.network)||!states.includes(s.lifecycleStatus)||!stamp(s.retrievedAt)||(s.providerDeadline!==null&&!stamp(s.providerDeadline))||
  !Array.isArray(s.orderLineIds)||s.orderLineIds.length>100||!s.orderLineIds.every(text)||!Array.isArray(s.allowedActions)||s.allowedActions.some((a:unknown)=>a!=='RESPOND'&&a!=='ACCEPT'))throw bad();
 return v as Claim;
}
function optionsFrom(v:unknown,proofId:string):Options{
 if(!object(v)||v.proofId!==proofId||!Array.isArray(v.payments)||v.payments.length>100||!Array.isArray(v.orderLines)||v.orderLines.length>100||
  v.payments.some((p:unknown)=>!object(p)||!text(p.integrationAccountId)||!text(p.providerAccountId)||!text(p.paymentId))||
  v.orderLines.some((l:unknown)=>!object(l)||!text(l.id)||(l.title!==null&&typeof l.title!=='string')||(l.quantity!==null&&(!Number.isInteger(l.quantity)||l.quantity<1))))throw new Error('Linked payments could not be read. Reload cases before continuing.');
 return v as Options;
}
const localTime=(value:string|null)=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const blank={reasonCode:'',network:'',lifecycleStatus:'',deadline:'',observedAt:'',respond:false,accept:false};

/** Parent keys this component by authenticated user, Proof and scoped packet. */
export function ClaimReviewPanel({api,userId,proofId,caseId,sources}:{api:PackProofApi;userId:string;proofId:string;caseId:string;sources:Array<{evidenceId:string;contentType:string}>}){
 const [cases,setCases]=useState<Claim[]>([]),[options,setOptions]=useState<Options|null>(null),[selected,setSelected]=useState('');
 const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[mode,setMode]=useState<'create'|'revise'|null>(null);
 const [form,setForm]=useState(blank),[paymentIndex,setPaymentIndex]=useState(''),[disputeId,setDisputeId]=useState(''),[lines,setLines]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false);
 const requestKey=useRef(randomId()),epoch=useRef(0),mounted=useRef(true),scope=`${api.recoveryScope}:${userId}:${proofId}:${caseId}`;
 const current=cases.find(c=>c.claimCaseId===selected);
 const changed=()=>{requestKey.current=randomId();setConfirmed(false);setError(null);};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
 useEffect(()=>{
  const version=++epoch.current;let active=true;setCases([]);setOptions(null);setMode(null);setError(null);setBusy(true);
  void Promise.all([api.featureRequest<unknown>(proofId,'claim-cases'),api.featureRequest<unknown>(proofId,'claim-cases/options')]).then(([value,choices])=>{
   if(!object(value)||!Array.isArray(value.cases)||value.cases.length>100)throw new Error('Cases could not be read.');
   const parsed=value.cases.map((c:unknown)=>claimFrom(c,proofId));if(new Set(parsed.map((c:Claim)=>c.claimCaseId)).size!==parsed.length)throw new Error('Case identities are inconsistent.');
   const available=optionsFrom(choices,proofId);
   if(active&&epoch.current===version){setCases(parsed);setOptions(available);setSelected(old=>parsed.some((c:Claim)=>c.claimCaseId===old)?old:'');}
  }).catch(e=>{if(active&&epoch.current===version)setError(e instanceof Error?e.message:'Case review is unavailable. Sign in again and retry.');}).finally(()=>{if(active&&epoch.current===version)setBusy(false);});
  return()=>{active=false;epoch.current++;};
 },[api,scope,refresh]);
 function edit(next:'create'|'revise'){
  changed();setMode(next);setDisputeId('');setPaymentIndex('');setLines([]);
  if(next==='revise'&&current){const s=current.snapshot;setForm({reasonCode:s.reasonCode,network:s.network,lifecycleStatus:s.lifecycleStatus,deadline:localTime(s.providerDeadline),observedAt:'',respond:s.allowedActions.includes('RESPOND'),accept:s.allowedActions.includes('ACCEPT')});}
  else setForm({...blank});
 }
 const observed=Date.parse(form.observedAt),deadline=form.deadline?Date.parse(form.deadline):null;
 const canSave=confirmed&&form.reasonCode&&networks.includes(form.network)&&states.includes(form.lifecycleStatus)&&Number.isFinite(observed)&&observed<=Date.now()&&(deadline===null||Number.isFinite(deadline))&&
  (mode==='create'?Boolean(options?.payments[Number(paymentIndex)]&&paymentIndex!==''&&disputeId.trim()):Boolean(current&&observed>Date.parse(current.snapshot.retrievedAt)));
 async function save(){
  if(busy||!canSave||!mode)return;const version=epoch.current,existing=mode==='revise'?current:undefined;setBusy(true);setError(null);
  const facts={reasonCode:form.reasonCode,network:form.network,lifecycleStatus:form.lifecycleStatus,providerDeadline:deadline===null?null:new Date(deadline).toISOString(),retrievedAt:new Date(observed).toISOString(),allowedActions:[...(form.respond?['RESPOND']:[]),...(form.accept?['ACCEPT']:[])],region:'US',paymentMethod:'CARD'};
  const payment=options!.payments[Number(paymentIndex)];
  const body=existing?{...facts,expectedSnapshotSha256:existing.snapshotSha256}:{...facts,integrationAccountId:payment.integrationAccountId,paymentId:payment.paymentId,disputeId:disputeId.trim(),orderLineIds:lines};
  try{
   const result=claimFrom(await api.claimWrite<unknown>(proofId,existing?.claimCaseId??null,body,requestKey.current),proofId);
   // A retry may return an earlier accepted revision. Reload current facts.
   const latest=claimFrom(await api.featureRequest<unknown>(proofId,`claim-cases/${encodeURIComponent(result.claimCaseId)}`),proofId);
   if(mounted.current&&version===epoch.current){setCases(old=>[latest,...old.filter(c=>c.claimCaseId!==latest.claimCaseId)]);setSelected(latest.claimCaseId);setMode(null);setConfirmed(false);}
  }catch(e){if(mounted.current&&version===epoch.current)setError(e instanceof Error?e.message:'Recording did not finish. Retry the same details to recover its result.');}
  finally{if(mounted.current&&version===epoch.current)setBusy(false);}
 }
 const s=current?.snapshot;
 const eligible=Boolean(current?.preservation.status==='PRESERVED'&&s&&['product_not_received','product_unacceptable'].includes(s.reasonCode)&&s.network!=='UNKNOWN'&&['needs_response','warning_needs_response'].includes(s.lifecycleStatus)&&s.allowedActions.includes('RESPOND')&&Date.parse(s.providerDeadline??'')>Date.now()&&Date.parse(s.retrievedAt)<=Date.now()&&Date.now()-Date.parse(s.retrievedAt)<=86400000);
 return <section className="stack" aria-label="Merchant claim review">
  <h4>Review a merchant dispute</h4>
  <p>Copy the current details from your direct Stripe account. These are your reported observations; PackProof has not verified the provider case. This workflow prepares files for your review.</p>
  {error&&<p role="alert">{error}</p>}
  <button className="btn btn-secondary" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Reload cases</button>
  {busy&&<p role="status">Loading or saving case details...</p>}
  {options&&<><label className="field"><span>Recorded dispute</span><select disabled={busy} value={selected} onChange={e=>{changed();setSelected(e.target.value);setMode(null);}}><option value="">Choose a dispute</option>{cases.map(c=><option key={c.claimCaseId} value={c.claimCaseId}>{c.snapshot.disputeId} - {c.snapshot.providerAccountId} - revision {c.revision}</option>)}</select></label>
   <button className="btn btn-secondary" disabled={busy||!options.payments.length} onClick={()=>edit('create')}>Record a new dispute</button>
   {!options.payments.length&&<p>No direct Stripe payment is linked to this Proof. A merchant administrator must establish the payment relationship first.</p>}
  </>}
  {current&&s&&<article className="stack"><h4>{s.disputeId}</h4><p>Account {s.providerAccountId}; payment {s.paymentId}. Revision {current.revision}. {s.reasonCode.replaceAll('_',' ')}; {s.network}; {s.lifecycleStatus.replaceAll('_',' ')}.</p><p>Observed {new Date(s.retrievedAt).toLocaleString()}. Deadline: {s.providerDeadline?new Date(s.providerDeadline).toLocaleString():'not recorded'}.</p><p>{s.orderLineIds.length?`${s.orderLineIds.length} affected order lines selected.`:'Payment-only scope; affected order lines were not identified.'}</p>
   {current.preservation.status!=='PRESERVED'&&<p role="status">Case preservation is pending. Reload cases before preparing files.</p>}
   <button className="btn btn-secondary" disabled={busy} onClick={()=>edit('revise')}>Record updated portal details</button>
  </article>}
  {mode&&<form className="stack" onSubmit={e=>{e.preventDefault();void save();}}><fieldset className="stack" disabled={busy}><legend>{mode==='create'?'New dispute details':'New observation of this dispute'}</legend>
   {mode==='create'&&<><label className="field"><span>Linked account and payment</span><select value={paymentIndex} onChange={e=>{changed();setPaymentIndex(e.target.value);}}><option value="">Choose a linked payment</option>{options?.payments.map((p,i)=><option key={`${p.integrationAccountId}:${p.paymentId}`} value={String(i)}>{p.providerAccountId} - {p.paymentId}</option>)}</select></label><label className="field"><span>Dispute reference</span><input maxLength={200} value={disputeId} onChange={e=>{changed();setDisputeId(e.target.value);}}/></label>
    {options?.orderLines.map(line=><label key={line.id}><input type="checkbox" checked={lines.includes(line.id)} onChange={e=>{changed();setLines(old=>e.target.checked?[...old,line.id]:old.filter(v=>v!==line.id));}}/>{line.title??'Order item'} (quantity {line.quantity??'not supplied'})</label>)}<p>Select affected order lines when known. Leaving them unselected records payment-only scope.</p></>}
   <label className="field"><span>Provider reason</span><select value={form.reasonCode} onChange={e=>{changed();setForm({...form,reasonCode:e.target.value});}}><option value="">Choose a reason</option><option value="product_not_received">Product not received</option><option value="product_unacceptable">Product unacceptable</option>{form.reasonCode&&!['product_not_received','product_unacceptable'].includes(form.reasonCode)&&<option value={form.reasonCode}>{form.reasonCode} (export unsupported)</option>}</select></label>
   <label className="field"><span>Card network</span><select value={form.network} onChange={e=>{changed();setForm({...form,network:e.target.value});}}><option value="">Choose a network</option>{networks.map(n=><option key={n} value={n}>{n}</option>)}</select></label>
   <label className="field"><span>Portal status</span><select value={form.lifecycleStatus} onChange={e=>{changed();setForm({...form,lifecycleStatus:e.target.value});}}><option value="">Choose a status</option>{states.map(n=><option key={n} value={n}>{n.replaceAll('_',' ')}</option>)}</select></label>
   <label className="field"><span>Portal deadline (local time)</span><input type="datetime-local" value={form.deadline} onChange={e=>{changed();setForm({...form,deadline:e.target.value});}}/></label>
   <label className="field"><span>When you checked the portal (local time)</span><input type="datetime-local" value={form.observedAt} onChange={e=>{changed();setForm({...form,observedAt:e.target.value});}}/></label>
   <label><input type="checkbox" checked={form.respond} onChange={e=>{changed();setForm({...form,respond:e.target.checked});}}/>The portal currently permits a response.</label>
   <label><input type="checkbox" checked={form.accept} onChange={e=>{changed();setForm({...form,accept:e.target.checked});}}/>The portal currently permits accepting the dispute.</label>
   <p>US card disputes only. Recording an available action does not perform it.</p>
   <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I checked these details in the named provider account.</label>
   <button className="btn" type="submit" disabled={!canSave}>{mode==='create'?'Save dispute details':'Save new observation'}</button>
   <button className="btn btn-secondary" type="button" onClick={()=>setMode(null)}>Cancel</button>
  </fieldset></form>}
  {current&&!mode&&!eligible&&<p>File preparation requires a preserved case, a supported reason and known network, a current response action, a future deadline and an observation from the last 24 hours.</p>}
  {current&&s&&eligible&&!mode&&<RecipientExportPanel key={`${scope}:${current.claimCaseId}:${current.snapshotSha256}`} api={api} userId={userId} proofId={proofId} caseId={caseId} sources={sources} claim={{claimCaseId:current.claimCaseId,snapshotSha256:current.snapshotSha256,deadline:s.providerDeadline!,network:s.network}}/>}
 </section>;
}
