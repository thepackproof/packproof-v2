import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import { randomId } from "../random-id";

type Subscription = {
  subscriptionReference:string;status:string;currentPeriodEnd:string|null;trialEnd:string|null;
  cancelAtPeriodEnd:boolean;cancelAt:string|null;canceledAt:string|null;endedAt:string|null;
  nextCharge:{expectedAt:string|null;baseAmountMinor:number|null;currency:string|null;estimate:boolean}|null;
};
type Status = {enabled:boolean;environment?:string;subscriptions:Subscription[];pendingCheckout:string|null};
type Offer = {enabled:boolean;environment?:string;offer:null|{
  version:string;sha256:string;priceMinor:number;currency:string;interval:string;
  includedFinalizedProofs:number;maxRecordingBytes:number;maxRecordingSeconds:number;
}};
const date=(value:string|null)=>value ? new Date(value).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}) : "Not yet available";
const money=(minor:number,currency:string)=>new Intl.NumberFormat(undefined,{style:"currency",currency}).format(minor/100);
export function safeBillingDestination(value:string,host:"checkout.stripe.com"|"billing.stripe.com"):string {
  const url=new URL(value);
  if(url.protocol!=="https:"||url.hostname!==host||url.port||url.username||url.password)throw new Error("The secure billing page could not be verified. Please retry.");
  return url.href;
}

export function PlanBillingPanel({api}:{api:PackProofApi}) {
  const [status,setStatus]=useState<Status|null>(null),[offer,setOffer]=useState<Offer|null>(null);
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const operation=useRef<string|null>(null);
  const mounted=useRef(true);
  async function refresh(){
    const next=await api.billingRequest<Status>("status");
    if(!mounted.current)return;
    setStatus(next);
    if(next.enabled){const available=await api.billingRequest<Offer>("offer");if(mounted.current)setOffer(available);}
  }
  useEffect(()=>{mounted.current=true;void refresh().catch(()=>{});return()=>{mounted.current=false;};},[api]);
  useEffect(()=>{setAccepted(false);},[offer?.offer?.sha256]);
  async function run(action:()=>Promise<void>){setBusy(true);setError(null);setNotice(null);try{await action();}catch(e){setError(e instanceof Error?e.message:"Billing could not be loaded. Please retry.");}finally{if(mounted.current)setBusy(false);}}
  if(!status?.enabled)return null;
  const active=status.subscriptions.some(s=>["active","trialing","past_due","unpaid","incomplete"].includes(s.status));
  const plan=offer?.enabled ? offer.offer : null;
  return <section className="section stack" aria-label="Plan and billing">
    <h2>Plan and billing</h2>
    {status.environment==="sandbox"&&<p className="note">Test billing. These are sandbox subscription details.</p>}
    {error&&<p className="banner banner-error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {status.subscriptions.map(s=><article className="stack" key={s.subscriptionReference}>
      <p><strong>{({active:"Active",trialing:"Trial",past_due:"Payment needs attention",unpaid:"Unpaid",canceled:"Canceled",incomplete:"Checkout incomplete",incomplete_expired:"Checkout expired",paused:"Paused"} as Record<string,string>)[s.status]??"Status needs review"}</strong></p>
      {s.trialEnd&&s.status==="trialing"&&<p>Trial ends {date(s.trialEnd)}.</p>}
      {(s.cancelAtPeriodEnd||s.cancelAt)&&<p>Cancellation scheduled for {date(s.cancelAt||s.currentPeriodEnd)}.</p>}
      {s.status==="canceled"&&<p>Subscription ended {date(s.endedAt||s.canceledAt)}.</p>}
      {s.nextCharge&&<p>Next expected base charge: {s.nextCharge.baseAmountMinor!==null&&s.nextCharge.currency ? money(s.nextCharge.baseAmountMinor,s.nextCharge.currency) : "Amount not yet available"} · {date(s.nextCharge.expectedAt)}. Taxes and adjustments may change the final invoice.</p>}
      {["active","trialing","past_due"].includes(s.status)&&!s.cancelAtPeriodEnd&&!s.cancelAt&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void run(async()=>{
        const result=await api.billingRequest<{url:string}>("cancellation-portal",{subscriptionReference:s.subscriptionReference,operationId:randomId()});
        window.location.assign(safeBillingDestination(result.url,"billing.stripe.com"));
      })}>Review cancellation</button>}
    </article>)}
    {status.pendingCheckout&&<div className="stack"><p>A checkout is awaiting confirmation.</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void run(async()=>{
      const result=await api.billingRequest<{state:string;enrolled:boolean}>("checkout/complete",{operationId:status.pendingCheckout});
      setNotice(result.enrolled?"Your plan is active.":result.state==="EXPIRED"?"Checkout expired. You can start again.":"Checkout is not complete yet. No enrollment has been confirmed.");
      await refresh();
    })}>Check checkout status</button>{plan&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void run(async()=>{
      const result=await api.billingRequest<{url:string|null}>("checkout",{operationId:status.pendingCheckout,offerVersion:plan.version,acceptedOfferSha256:plan.sha256});
      if(result.url)window.location.assign(safeBillingDestination(result.url,"checkout.stripe.com"));else await refresh();
    })}>Return to secure checkout</button>}</div>}
    {!active&&!status.pendingCheckout&&plan&&<div className="stack">
      <p><strong>{money(plan.priceMinor,plan.currency)} per month</strong> · {plan.includedFinalizedProofs} Proofs included.</p>
      <p className="note">Recordings up to {Math.floor(plan.maxRecordingSeconds/60)} minutes and {(plan.maxRecordingBytes/1_000_000).toFixed(0)} MB. New captures pause when your allowance is used. Existing evidence stays accessible under its retention policy.</p>
      <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> I accept this recurring monthly offer and the <a href="/new/terms" target="_blank" rel="noreferrer">Terms of Service</a>.</label>
      <button type="button" className="btn" disabled={busy||!accepted} onClick={()=>void run(async()=>{
        operation.current??=randomId();
        const result=await api.billingRequest<{url:string|null;state:string}>("checkout",{operationId:operation.current,offerVersion:plan.version,acceptedOfferSha256:plan.sha256});
        if(result.url)window.location.assign(safeBillingDestination(result.url,"checkout.stripe.com"));else await refresh();
      })}>{busy?"Opening checkout…":"Continue to secure checkout"}</button>
    </div>}
  </section>;
}
