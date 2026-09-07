import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
export type UsageView = {window:{start:string;end:string};finalizedWithDurabilityReceipt:number;finalizedWithoutConfirmedDurability:number;recordedUsageUnits:number;message:string;currentOffer:null|{version:string;remaining:number;includedFinalizedProofs:number;period:{end:string}}};
type Props={api:PackProofApi;userId:string};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
function usageView(value:unknown):UsageView{
  if(!object(value)||!object(value.window)||!date(value.window.start)||!date(value.window.end)||typeof value.message!=='string'||!count(value.finalizedWithDurabilityReceipt)||!count(value.finalizedWithoutConfirmedDurability)||!count(value.recordedUsageUnits))throw new Error('Usage is unavailable');
  const offer=value.currentOffer;
  if(offer!==null&&(!object(offer)||typeof offer.version!=='string'||!count(offer.remaining)||!count(offer.includedFinalizedProofs)||!object(offer.period)||!date(offer.period.end)))throw new Error('Usage offer is unavailable');
  return value as UsageView;
}
export function UsagePanel(props:Props){return <ScopedUsage key={JSON.stringify([props.api.recoveryScope,props.userId])} {...props}/>;}
function ScopedUsage({api}:Props) {
  const [usage,setUsage]=useState<UsageView|null>(null),[error,setError]=useState(false);
  useEffect(()=>{let active=true;void api.getUsage<unknown>().then(value=>{const parsed=usageView(value);if(active){setUsage(parsed);setError(false);}}).catch(()=>{if(active){setUsage(null);setError(true);}});return()=>{active=false;};},[api]);
  return <section className="page"><details><summary>Proof usage</summary>{error?<p role="status">Usage is temporarily unavailable.</p>:usage?<div className="stack">
    <p>{usage.message}</p><dl><dt>Preserved finalized Proofs this month</dt><dd>{usage.finalizedWithDurabilityReceipt}</dd><dt>Finalized records awaiting durability confirmation</dt><dd>{usage.finalizedWithoutConfirmedDurability}</dd><dt>Recorded usage units</dt><dd>{usage.recordedUsageUnits}</dd></dl>
    {usage.currentOffer&&<p>{usage.currentOffer.remaining} of {usage.currentOffer.includedFinalizedProofs} included Proofs remain through {new Date(usage.currentOffer.period.end).toLocaleDateString()}.</p>}
    <p className="note">Your remaining new-capture allowance does not control retrieval of past Proofs or change their preservation.</p>
  </div>:<p>Loading usage…</p>}</details></section>;
}
