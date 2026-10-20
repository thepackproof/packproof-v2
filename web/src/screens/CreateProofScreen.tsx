import { SignalSteps } from '../signal/Signal';
import { useEffect, useState, type ReactNode } from "react";
import { readDraft, saveDraft, pendingCreationRequest, sameCreationRequest } from "../first-experience/state";
import type { IntakePreview } from "@packproof/copy/order-intake";
import { IntakePanel } from "../components/IntakePanel";
import type { EbaySellerOrderView, TransactionImportView, TransactionWriteInput } from "../api/types";
import { PageHeader } from "../components/PageHeader";
import { useBrowserOnline } from "../components/WorkstationHeader";
export function CreateProofScreen(props: {
  draftKey?: string;
  initialReference?: string;
  readyOrders?: ReactNode;
  busy: boolean;
  error: string | null;
  development: boolean;
  ebayConnected: boolean;
  onCancel: () => void;
  onScan: () => void;
  onOpenAccount: () => void;
  onAcceptInvitation: (invitationId: string) => void;
  onPreviewIntake?: (text: string) => Promise<IntakePreview>;
  renderIntakePanel?: (onReview: (preview: IntakePreview) => void) => ReactNode;
  onCreate: (input: TransactionWriteInput) => void;
  onCreateGrading: (input: { itemCount: number; itemTitle: string }) => void;
  onImportPurchase: () => Promise<TransactionImportView>;
  onListEbayOrders: () => Promise<{
    orders: EbaySellerOrderView[];
    disclosure: string;
  }>;
  onImportEbayOrder: (orderId: string) => Promise<TransactionImportView>;
  onConfirmImport: (transactionId: string) => void;
}) {
  const [saved] = useState(() => readDraft<{ title: string; reference: string; description: string; currency: string; quantity: string; amount: string; carrier: string; tracking: string; intake: IntakePreview | null }>(props.draftKey));
  const [title, setTitle] = useState(saved?.title || "");
  const [reference, setReference] = useState(saved?.reference || props.initialReference || "");
  const online = useBrowserOnline();
  const [description, setDescription] = useState(saved?.description || "");
  const [currency, setCurrency] = useState(saved?.currency || "USD");
  const [quantity, setQuantity] = useState(saved?.quantity || "1");
  const [amount, setAmount] = useState(saved?.amount || "");
  const [carrier, setCarrier] = useState(saved?.carrier || "");
  const [tracking, setTracking] = useState(saved?.tracking || "");
  const [paste, setPaste] = useState(false);
  const [intake, setIntake] = useState<IntakePreview | null>(saved?.intake || null);
  const [draftSaved, setDraftSaved] = useState(true);
  useEffect(() => {
    if (props.draftKey) setDraftSaved(saveDraft(props.draftKey, { title, reference, description, currency, quantity, amount, carrier, tracking, intake }));
  }, [props.draftKey, title, reference, description, currency, quantity, amount, carrier, tracking, intake]);
  const [gradingCount, setGradingCount] = useState("1");
  function reviewIntake(result: IntakePreview) { setIntake(result); setTitle(result.draft.itemTitle || ""); setReference(result.draft.externalReference || ""); setCurrency(result.draft.currency || "USD"); setQuantity(result.draft.quantity == null ? "1" : String(result.draft.quantity)); setAmount(result.draft.transactionValue == null ? "" : String(result.draft.transactionValue)); setCarrier(result.draft.shipping.carrier || ""); setTracking(result.draft.shipping.trackingNumber || ""); setPaste(false); }
  const quantityNumber = Math.max(1, Number.parseInt(quantity,10) || 1);
  const request:TransactionWriteInput={itemTitle:title.trim(),externalReference:reference.trim()||null,itemDescription:description.trim()||null,currency:currency.trim()||null,quantity:quantity?Number(quantity):null,transactionValue:amount?Number(amount):null,shipping:{carrier:carrier.trim()||null,trackingNumber:tracking.trim()||null},...(intake?{metadata:{intake:{...intake.draft.metadata.intake,confirmed:true}}}:{})};
  const pendingRequest=pendingCreationRequest(props.draftKey);
  const changedPending=!!pendingRequest&&!sameCreationRequest(pendingRequest,request);
  return <main className="page narrow-page signal-create"><PageHeader title="New Proof" onBack={props.onCancel} /><SignalSteps step={1}/><p className="signal-mono">LET’S START WITH THE ITEM.</p><h1>What are you<br/>packing?</h1><p>Use a name you’ll recognize later.</p>
    {!online && <p className="banner" role="status">Connect before opening the camera. {props.draftKey && draftSaved ? "Your draft is saved in this browser for this account." : "Keep this form open to retain your entered details."}</p>}
    {!draftSaved && <p className="banner" role="status">This browser could not save your draft. Keep this form open; your details may need to be entered again after closing it.</p>}
    {props.initialReference && <p className="note">Shipment reference: {props.initialReference}. Check the optional details before opening the camera.</p>}
    {props.readyOrders}
    {props.error ? <p role="alert" className="banner banner-error">{props.error}</p> : null}
    {changedPending&&<section className="banner" aria-label="Pending creation recovery"><p>A creation request for <strong>{pendingRequest?.itemTitle||'this shipment'}</strong> may already have been saved. Changes in this form have not been sent.</p><button type="button" className="btn btn-secondary" disabled={props.busy||!online} onClick={()=>{if(pendingRequest)props.onCreate(pendingRequest);}}>Recover submitted draft</button><p>This resumes the original details so the same shipment does not get another Proof.</p></section>}
    {paste && props.onPreviewIntake ? (props.renderIntakePanel ? props.renderIntakePanel(reviewIntake) : <IntakePanel onPreview={props.onPreviewIntake} onReview={reviewIntake} />) : null}
    <form className="stack" onSubmit={e => { e.preventDefault(); if(!changedPending)props.onCreate(request); }}>
      <label className="field"><span>Item name</span><input className="signal-item-name" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} autoFocus /></label>

      {intake ? <div className="note"><p>These details came from text you provided. Check them before recording.</p>{intake.warnings.map((warning,index)=><p key={index}>{warning}</p>)}<button className="btn btn-tertiary" type="button" onClick={()=>{setIntake(null);setTitle("");setReference("");setDescription("");setCurrency("USD");setQuantity("1");setAmount("");setCarrier("");setTracking("");}}>Clear pasted details</button></div> : null}
      {props.onPreviewIntake ? <button className="btn btn-tertiary" type="button" onClick={() => setPaste(!paste)}>Paste order or receipt</button> : null}
      <details open={Boolean(intake)}><summary>＋ Add order or shipment details</summary><div className="stack">
        <label className="field"><span>Your reference (optional)</span><input placeholder="A reference you provide" value={reference} onChange={e => setReference(e.target.value)} /></label>
        <label className="field"><span>Description</span><textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="field"><span>Currency</span><select value={currency} onChange={e=>setCurrency(e.target.value)}><option value="USD">USD</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="AUD">AUD</option></select></label>
        <div className="field"><span>Quantity</span><div className="row" style={{justifyContent:'flex-start'}}><button className="btn btn-tertiary" type="button" aria-label="Decrease quantity" disabled={quantityNumber <= 1} onClick={()=>setQuantity(String(Math.max(1,quantityNumber-1)))}>−</button><input style={{maxWidth:'8rem'}} aria-label="Quantity" type="number" min={1} step={1} value={quantity} onChange={e=>setQuantity(e.target.value)} /><button className="btn btn-tertiary" type="button" aria-label="Increase quantity" onClick={()=>setQuantity(String(quantityNumber+1))}>+</button></div></div>
        <label className="field"><span>Value ({currency})</span><input inputMode="decimal" placeholder="0.00" type="number" min={0} step="any" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
        <label className="field"><span>Carrier</span><input placeholder="USPS, UPS, FedEx…" value={carrier} onChange={e=>setCarrier(e.target.value)} /></label>
        <label className="field"><span>Tracking number</span><input value={tracking} onChange={e=>setTracking(e.target.value)} /></label>
      </div></details>
      <div className="signal-create-footer"><strong>One item. One clear record.</strong><p>Your recording and confirmation stay together in this Proof.</p><button className="btn" disabled={props.busy || !title.trim() || !online || changedPending} type="submit">{props.busy ? "Preparing…" : "Continue to camera →"}</button><p className="signal-caption">You choose when recording starts.</p></div>
    </form>
    <details><summary>Document a grading submission</summary>
      <label className="field"><span>Number of items</span><input value={gradingCount} onChange={e => setGradingCount(e.target.value)} type="number" min={1} max={50} step={1} /></label>
      <button className="btn btn-secondary" type="button" disabled={props.busy || !Number.isSafeInteger(Number(gradingCount)) || Number(gradingCount) < 1 || Number(gradingCount) > 50} onClick={() => props.onCreateGrading({ itemCount: Number(gradingCount), itemTitle: title.trim() || "Grading submission" })}>Start grading submission</button>
    </details>
  </main>;
}
