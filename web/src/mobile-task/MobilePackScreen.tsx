import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import { ApiError, type FulfillmentQueueItem, type PackingStationResolveView, type ProofCollectionItem } from "../api/types";
import { BrowserIdentifierDecoder } from "../capture/identifier-decoder";
import { useBrowserOnline } from "../components/WorkstationHeader";
import { MobileProofRows } from "./MobileProofRows";

export function MobilePackScreen(props: { api: PackProofApi; queue: FulfillmentQueueItem[]; loading: boolean; error: string | null; onRetry: () => void; onGo: (path: string) => void; onOpen: (id: string) => void; onCreate: (reference?: string) => void }) {
  const online = useBrowserOnline();
  const [reference, setReference] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [result, setResult] = useState<PackingStationResolveView | null>(null);
  const [matches, setMatches] = useState<ProofCollectionItem[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const lookupPending = useRef(false);
  useEffect(() => {
    if (!scanning) return;
    let active = true, stream: MediaStream | undefined, decoder: BrowserIdentifierDecoder | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stream?.getTracks().forEach(track => track.stop()); decoder?.close(); if (timer) clearTimeout(timer); };
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera scanning is unavailable. Enter the shipment reference below.");
        decoder = new BrowserIdentifierDecoder();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!active) { stop(); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const read = async () => {
          if (!active || !video.current) return;
          try {
            const frame = await decoder!.detect(video.current);
            if (!active) return;
            const code = frame?.codes.find(item => item.rawText.trim() && item.rawText.length <= 200);
            if (code) { setReference(code.rawText.trim()); setScanning(false); setError(null); return; }
            timer = setTimeout(() => void read(), 400);
          } catch { if (active) { setError("The camera could not read this code. Enter the reference manually."); setScanning(false); } }
        };
        void read();
      } catch (caught) {
        if (active) { setError(caught instanceof DOMException && caught.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser or enter the reference manually." : caught instanceof Error ? caught.message : "Camera scanning is unavailable. Enter the reference manually."); setScanning(false); }
      }
    })();
    return () => { active = false; stop(); };
  }, [scanning]);
  async function identify() {
    const value = reference.trim();
    if (!value || lookupPending.current || !online) return;
    lookupPending.current = true; setBusy(true); setMissing(false); setResult(null); setMatches([]); setError(null);
    try { setResult(await props.api.resolvePackingStation(value)); }
    catch (caught) {
      if (caught instanceof ApiError && ["STATION_REFERENCE_NOT_FOUND", "TRANSACTION_NOT_FOUND"].includes(caught.code)) setMissing(true);
      else if (caught instanceof ApiError && /AMBIGUOUS|MULTIPLE/.test(caught.code)) {
        const rows = await props.api.listProofs({ view: "all", q: value });
        setMatches(rows.proofs); setError("More than one shipment matches. Select the correct Proof before recording.");
      } else setError(caught instanceof Error ? caught.message : "Shipment lookup could not finish. Try again.");
    } finally { lookupPending.current = false; setBusy(false); }
  }
  const ready = props.queue.filter(order => order.proofStatus !== "FINALIZED" && !["COMPLETED", "REMOVED_FROM_FULFILLMENT"].includes(order.workflowState));
  return <main className="page task-stack mobile-pack-page">
    <h1 className="page-title">Pack</h1>
    <div className="task-pack-entrances"><button className="btn" onClick={() => { setError(null); setScanning(true); }}>Scan shipment</button><button className="btn btn-secondary" onClick={() => props.onGo("/proofs?filter=attention")}>Select existing Proof</button><button className="btn btn-secondary" onClick={() => props.onCreate()}>Create new Proof</button></div>
    {!online && <p className="task-notice" role="status">A connection is needed to identify or create a shipment. Saved recordings are available in Activity.</p>}
    {scanning && <section className="task-stack"><video ref={video} className="task-scanner" muted playsInline aria-label="Shipment barcode camera" /><p>Scan identifies a shipment. It does not record evidence.</p><button className="btn btn-secondary" onClick={() => setScanning(false)}>Stop scanning</button></section>}
    <form className="task-stack" onSubmit={event => { event.preventDefault(); void identify().catch(() => setError("Shipment lookup could not finish. Try again.")); }}><label className="field"><span>Order or tracking reference</span><input value={reference} maxLength={200} onChange={event => { setReference(event.target.value); setResult(null); setMissing(false); }} autoComplete="off" autoCapitalize="none" /></label><button className="btn btn-secondary" disabled={busy || !online || !reference.trim()}>{busy ? "Finding shipment…" : "Find shipment"}</button></form>
    {error && <p className="task-notice" role="alert">{error}</p>}
    {result && <section className="task-activity-row"><h2>{result.itemSummary}</h2><p>{result.orderLabel}</p>{result.blockReason && <p>{result.blockReason}</p>}<button className="btn" disabled={busy} onClick={() => { if (result.proofId) props.onOpen(result.proofId); else { setBusy(true); void props.api.createOrGetProof(result.transactionId).then(proof => props.onOpen(proof.proofId)).catch(caught => setError(caught instanceof Error ? caught.message : "This shipment could not be opened.")).finally(() => setBusy(false)); } }}>{result.alreadyFinalized ? "View Proof" : "Continue Proof"}</button></section>}
    {matches.length > 0 && <MobileProofRows proofs={matches} onOpen={proof => props.onOpen(proof.proofId)} />}
    {missing && <section className="task-activity-row"><h2>No matching shipment</h2><p>Create a Proof with this reference. Check the shipment details before opening the camera.</p><button className="btn" onClick={() => props.onCreate(reference.trim())}>Create Proof with this reference</button></section>}
    <section className="task-stack"><div className="task-section-heading"><h2>Ready to pack</h2><button className="text-link" onClick={() => props.onGo("/fulfillment")}>Orders</button></div>{props.loading ? <p role="status">Loading shipments…</p> : props.error ? <div className="task-notice"><p>{props.error}</p><button className="btn btn-secondary" onClick={props.onRetry}>Try again</button></div> : ready.length ? <ul className="task-proof-list">{ready.slice(0, 5).map(order => <li key={order.proofId}><div><h3>{order.itemSummary}</h3><p>{order.externalReference || order.externalOrderId}</p></div><button className="btn btn-secondary" onClick={() => props.onOpen(order.proofId)}>Start packing</button></li>)}</ul> : <p className="task-notice">No shipments waiting. Create a Proof above to record any shipment; marketplace connections are optional.</p>}</section>
  </main>;
}
