import { useState } from "react";
import type { IntakePreview } from "@packproof/copy/order-intake";
import { IntakePanel } from "../components/IntakePanel";
import type { EbaySellerOrderView, TransactionImportView, TransactionWriteInput } from "../api/types";
import { PageHeader } from "../components/PageHeader";
export function CreateProofScreen(props: {
  busy: boolean;
  error: string | null;
  development: boolean;
  ebayConnected: boolean;
  onCancel: () => void;
  onScan: () => void;
  onOpenAccount: () => void;
  onAcceptInvitation: (invitationId: string) => void;
  onPreviewIntake?: (text: string) => Promise<IntakePreview>;
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
  const [title, setTitle] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [quantity, setQuantity] = useState("1");
  const [amount, setAmount] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [paste, setPaste] = useState(false);
  const [intake, setIntake] = useState<IntakePreview | null>(null);
  const quantityNumber = Math.max(1, Number.parseInt(quantity,10) || 1);
  return <main className="page narrow-page"><PageHeader title="Record shipment" onBack={props.onCancel} />
    {props.error ? <p role="alert" className="banner banner-error">{props.error}</p> : null}
    {paste && props.onPreviewIntake ? <IntakePanel onPreview={props.onPreviewIntake} onReview={result => { setIntake(result); setTitle(result.draft.itemTitle || ""); setReference(result.draft.externalReference || ""); setCurrency(result.draft.currency || "USD"); setQuantity(result.draft.quantity == null ? "1" : String(result.draft.quantity)); setAmount(result.draft.transactionValue == null ? "" : String(result.draft.transactionValue)); setCarrier(result.draft.shipping.carrier || ""); setTracking(result.draft.shipping.trackingNumber || ""); setPaste(false); }} /> : null}
    <form className="stack" onSubmit={e => { e.preventDefault(); props.onCreate({itemTitle:title.trim(),externalReference:reference.trim() || null,itemDescription:description.trim() || null,currency:currency.trim() || null,quantity:quantity ? Number(quantity) : null,transactionValue:amount ? Number(amount) : null,shipping:{carrier:carrier.trim() || null,trackingNumber:tracking.trim() || null},...(intake ? {metadata:{intake:{...intake.draft.metadata.intake,confirmed:true}}} : {})}); }}>
      <label className="field"><span>What are you shipping?</span><input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} autoFocus /></label>
      <p>Show the shipping label during your packing video. PackProof will try to read it for you.</p>
      {intake ? <div className="note"><p>These details came from text you provided. Check them before recording.</p>{intake.warnings.map((warning,index)=><p key={index}>{warning}</p>)}<button className="btn btn-tertiary" type="button" onClick={()=>{setIntake(null);setTitle("");setReference("");setDescription("");setCurrency("USD");setQuantity("1");setAmount("");setCarrier("");setTracking("");}}>Clear pasted details</button></div> : null}
      {props.onPreviewIntake ? <button className="btn btn-tertiary" type="button" onClick={() => setPaste(!paste)}>Paste order or receipt</button> : null}
      <details open={Boolean(intake)}><summary>Optional details</summary><div className="stack">
        <label className="field"><span>Order number (optional)</span><input placeholder="Store or marketplace order #" value={reference} onChange={e => setReference(e.target.value)} /></label>
        <label className="field"><span>Description</span><textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="field"><span>Currency</span><select value={currency} onChange={e=>setCurrency(e.target.value)}><option value="USD">USD</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="AUD">AUD</option></select></label>
        <div className="field"><span>Quantity</span><div className="row" style={{justifyContent:'flex-start'}}><button className="btn btn-tertiary" type="button" aria-label="Decrease quantity" disabled={quantityNumber <= 1} onClick={()=>setQuantity(String(Math.max(1,quantityNumber-1)))}>−</button><input style={{maxWidth:'8rem'}} aria-label="Quantity" type="number" min={1} step={1} value={quantity} onChange={e=>setQuantity(e.target.value)} /><button className="btn btn-tertiary" type="button" aria-label="Increase quantity" onClick={()=>setQuantity(String(quantityNumber+1))}>+</button></div></div>
        <label className="field"><span>Value ({currency})</span><input inputMode="decimal" placeholder="0.00" type="number" min={0} step="any" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
        <label className="field"><span>Carrier</span><input placeholder="USPS, UPS, FedEx…" value={carrier} onChange={e=>setCarrier(e.target.value)} /></label>
        <label className="field"><span>Tracking number</span><input value={tracking} onChange={e=>setTracking(e.target.value)} /></label>
      </div></details>
      <button className="btn" disabled={props.busy || !title.trim()} type="submit">{props.busy ? "Opening…" : "Open camera"}</button>
    </form>
  </main>;
}
