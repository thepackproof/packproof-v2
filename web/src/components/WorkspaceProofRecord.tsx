import { useEffect, useRef, useState, type ReactNode } from "react";
import { isGradingWorkflow, participantFacingRole } from "@packproof/copy/custody";
import { moneyLabel, orderReferenceLabel, quantityLabel } from "@packproof/copy/format";
import { humanProofStatus } from "@packproof/copy/status";
import type { PackProofApi } from "../api/client";
import type { CanonicalProof, ChronologyEntry } from "../api/types";
import { formatWhen } from "../format";
import { useViewState } from "../navigation-context";
import { Glyph } from "../site/Brand";
import { EvidencePreview, mediaType, useEvidenceBlob } from "./EvidencePreview";
import { ProofTimeline } from "./ProofTimeline";
import { ShipmentTracking } from "./ShipmentTracking";
import { StatusBadge } from "./StatusBadge";

const tabs = ["Evidence", "Timeline", "Tracking", "Receipt"] as const;
type RecordTab = typeof tabs[number];
type Bookmark = {
  anchorId: string;
  evidenceId: string | null;
  stageId: string | null;
  label: string;
  startMs: number | null;
  endMs: number | null;
  sourceHash: string;
  sourceCategory: string;
  supersedesId: string | null;
};
type ReceiptState = {
  role: string;
  stages: Array<{ stageId: string; type: string; finalizedAt: string | null }>;
};

function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The live counterpart of the public SampleProof, using only this participant's sources. */
export function WorkspaceProofRecord(props: {
  proof: CanonicalProof;
  currentUserId: string;
  role?: string;
  api?: PackProofApi;
  busy?: boolean;
  loadEvidence?: (id: string) => Promise<Blob>;
  onOpenEvent?: (entry: ChronologyEntry) => void;
  onOpenReceipt?: () => void;
  onReviewSharing?: () => void;
  trackingTools?: ReactNode;
}) {
  const { proof } = props;
  const scope = `${props.api?.recoveryScope || location.origin}.${props.currentUserId}.${proof.proofId}`;
  const [savedTab, setTab] = useViewState<RecordTab>(`proof.${scope}.recordTab`, "Evidence");
  const tab = tabs.includes(savedTab) ? savedTab : "Evidence";
  const controls = useRef<Array<HTMLButtonElement | null>>([]);
  const title = proof.transaction.itemTitle?.trim() || "Untitled item";
  const reference = orderReferenceLabel(proof.transaction.externalReference);

  function select(next: RecordTab, focus = false) {
    setTab(next);
    const button = controls.current[tabs.indexOf(next)];
    if (focus) button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  return <article className="workspace-proof-record" aria-label="Proof record" data-context-anchor={`proof-record-${proof.proofId}`}>
    <header className="record-top">
      <div><h2>{title}{reference ? ` · ${reference}` : ""}</h2><p><span>{proof.status === "FINALIZED" ? "Finalized Proof" : "Proof in progress"}</span>{props.role && <> · <span>You are the {participantFacingRole(proof.workflowType, props.role)}</span></>}</p></div>
      <StatusBadge label={humanProofStatus({ proofStatus: proof.status })} />
    </header>
    <div className="record-tabs" role="tablist" aria-label="Proof record views">
      {tabs.map((name, index) => <button
        key={name}
        ref={element => { controls.current[index] = element; }}
        id={`record-${proof.proofId}-${name}-tab`}
        type="button"
        role="tab"
        aria-selected={tab === name}
        aria-controls={`record-${proof.proofId}-${name}-panel`}
        tabIndex={tab === name ? 0 : -1}
        onClick={() => select(name)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); select(tabs[next], true); }
        }}
      >{name}</button>)}
    </div>
    <div key={tab} className="record-body" role="tabpanel" tabIndex={0} id={`record-${proof.proofId}-${tab}-panel`} aria-labelledby={`record-${proof.proofId}-${tab}-tab`}>
      {tab === "Evidence" && <RecordEvidence key={scope} scope={scope} proof={proof} api={props.api} load={props.loadEvidence} />}
      {tab === "Timeline" && <>
        <ProofTimeline entries={proof.chronology ?? []} finalizedAt={proof.finalizedAt} onSelect={props.onOpenEvent} />
        {proof.status === "FINALIZED" && <p className="note record-source-note">The core record was frozen {formatWhen(proof.finalizedAt)}. Later carrier observations are appended separately.</p>}
      </>}
      {tab === "Tracking" && <div className="stack">
        <ShipmentTracking events={proof.shipmentObservations?.events ?? []} carrier={proof.transaction.shipping?.carrier} trackingNumber={proof.transaction.shipping?.trackingNumber} />
        {props.trackingTools}
      </div>}
      {tab === "Receipt" && <RecordReceipt key={proof.proofId} proof={proof} role={props.role} api={props.api} busy={props.busy} onOpenReceipt={props.onOpenReceipt} onReviewSharing={props.onReviewSharing} onReviewEvidence={() => select("Evidence", true)} />}
    </div>
  </article>;
}

function RecordEvidence({ proof, api, load, scope }: { proof: CanonicalProof; api?: PackProofApi; load?: (id: string) => Promise<Blob>; scope: string }) {
  const evidence = proof.evidence.filter(item => item.validationStatus === "COMMITTED");
  const preview = useEvidenceBlob(proof.proofId);
  const [selected, setSelected] = useViewState<string | null>(`proof.${scope}.recordEvidence`, null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const current = evidence.find(item => item.evidenceId === preview.selectedId);

  function playbackKey(id: string) { return `packproof.view.recordPlayback.${scope}.${id}`; }
  function restoreTime(id: string) {
    try { const value = Number(sessionStorage.getItem(playbackKey(id))); return Number.isFinite(value) && value >= 0 ? value : 0; }
    catch { return 0; }
  }
  async function open(id: string, at?: number) {
    const item = evidence.find(candidate => candidate.evidenceId === id);
    if (!item || !load) return;
    pendingSeek.current = at ?? restoreTime(id);
    setSelected(id);
    if (current?.evidenceId === id && preview.url && video.current) {
      video.current.currentTime = Math.min(pendingSeek.current, Number.isFinite(video.current.duration) ? video.current.duration : pendingSeek.current);
      pendingSeek.current = null;
      video.current.focus({ preventScroll: true });
      return;
    }
    await preview.open(id, item.contentType, load);
  }

  useEffect(() => {
    if (!load || !evidence.length) return;
    const first = evidence.find(item => item.evidenceId === selected)
      ?? evidence.find(item => mediaType(item.contentType).startsWith("video/")) ?? evidence[0];
    void open(first.evidenceId);
    // Re-run after StrictMode's cleanup invalidates the first media request.
    // A fresh parent callback should not reload a playing original.
  }, [Boolean(load), evidence.length]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    setBookmarkError(null);
    void api.featureRequest<{ snapshot?: { data?: { anchors?: Bookmark[] } } }>(proof.proofId, "signature/")
      .then(data => {
        if (!Array.isArray(data.snapshot?.data?.anchors)) throw new Error("Bookmarks are unavailable from this server.");
        if (active) setBookmarks(data.snapshot.data.anchors);
      })
      .catch(() => { if (active) setBookmarkError("Bookmarks couldn’t be loaded. Your original evidence remains available."); });
    return () => { active = false; };
  }, [api, proof.proofId, proof.updatedAt, retry]);

  const visibleBookmarks = bookmarks.filter(bookmark => !bookmark.stageId && bookmark.evidenceId === current?.evidenceId
    && bookmark.sourceHash === (current?.digest?.sha256 || current?.sha256) && Boolean(bookmark.sourceHash)
    && typeof bookmark.startMs === "number" && Number.isFinite(bookmark.startMs) && bookmark.startMs >= 0
    && typeof bookmark.endMs === "number" && Number.isFinite(bookmark.endMs) && bookmark.endMs > bookmark.startMs
    && !bookmarks.some(replacement => replacement.supersedesId === bookmark.anchorId))
    .sort((a, b) => a.startMs! - b.startMs!);

  if (!evidence.length) return <div className="evidence-placeholder"><span><Glyph name="film" size={28} /></span><strong>No evidence secured yet</strong><p>Your committed recording will appear here after capture and upload.</p></div>;
  if (!load) return <div className="evidence-placeholder"><span><Glyph name="film" size={28} /></span><strong>{evidence.length} committed evidence file{evidence.length === 1 ? "" : "s"}</strong><p>Media playback isn’t available in this view.</p></div>;

  return <div className="record-evidence stack">
    {preview.url && current ? <EvidencePreview
      url={preview.url}
      contentType={preview.contentType}
      evidenceId={current.evidenceId}
      title={preview.contentType.startsWith("video/") && ["SELLER_EVIDENCE", "FULFILLMENT_CAPTURE"].includes(current.evidenceType) ? `Packing ${proof.transaction.itemTitle?.trim() || "the item"}` : "Recorded evidence"}
      videoRef={video}
      onLoadedMetadata={event => {
        if (pendingSeek.current === null) return;
        const player = event.currentTarget;
        player.currentTime = Math.min(pendingSeek.current, Number.isFinite(player.duration) ? player.duration : pendingSeek.current);
        pendingSeek.current = null;
      }}
      onTimeUpdate={event => { try { sessionStorage.setItem(playbackKey(current.evidenceId), String(event.currentTarget.currentTime)); } catch { /* Playback works without storage. */ } }}
    /> : <div className="evidence-placeholder" aria-busy={preview.busy}><span><Glyph name={preview.busy ? "clock" : "film"} size={28} /></span><strong>{preview.busy ? "Loading your evidence…" : "Open the recorded evidence"}</strong><p>The original file is retrieved securely from this Proof.</p></div>}
    {evidence.length > 1 && <div className="evidence-file-tabs" aria-label="Evidence files">{evidence.map((item, index) => {
      const type = mediaType(item.contentType);
      const label = type.startsWith("video/") ? "Video" : type.startsWith("image/") ? "Image" : type === "application/pdf" ? "Document" : "File";
      return <button type="button" key={item.evidenceId} aria-pressed={current?.evidenceId === item.evidenceId} onClick={() => void open(item.evidenceId)}><Glyph name={type.startsWith("video/") ? "film" : "file"} size={17} />{label} {index + 1}</button>;
    })}</div>}
    {preview.error && <div className="banner banner-error" role="alert"><p>{preview.error}</p><button className="btn btn-secondary" onClick={() => void open(preview.selectedId || evidence[0].evidenceId)}>Retry evidence</button></div>}
    {preview.url && preview.contentType.startsWith("video/") && <>
      {visibleBookmarks.length > 0 ? <div className="record-chapters" aria-label="Recorded source moments">{visibleBookmarks.map(bookmark => <button type="button" key={bookmark.anchorId} onClick={() => void open(bookmark.evidenceId!, bookmark.startMs! / 1000)} title={`Source: ${bookmark.sourceCategory.replaceAll("_", " ").toLowerCase()}`}>{elapsed(bookmark.startMs!)} · {bookmark.label}</button>)}</div> : !bookmarkError && <p className="note">No bookmarks recorded for this video. Use the player to review the original.</p>}
      {visibleBookmarks.length > 0 && <p className="note">Recorded bookmarks point to moments in the original video. Labels describe the source; they do not establish what happened outside the recording.</p>}
    </>}
    {bookmarkError && <p className="note" role="status">{bookmarkError} <button className="text-link" onClick={() => setRetry(value => value + 1)}>Retry bookmarks</button></p>}
  </div>;
}

function RecordReceipt({ proof, role, api, busy, onOpenReceipt, onReviewEvidence, onReviewSharing }: {
  proof: CanonicalProof;
  role?: string;
  api?: PackProofApi;
  busy?: boolean;
  onOpenReceipt?: () => void;
  onReviewEvidence: () => void;
  onReviewSharing?: () => void;
}) {
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const ordinary = !isGradingWorkflow(proof.workflowType);
  const participant = role === "SELLER" || role === "BUYER";
  const available = ordinary && participant && proof.status === "FINALIZED";
  useEffect(() => {
    if (!available || !api) return;
    let active = true;
    setError(false);
    void api.lifecycleRequest<ReceiptState>(proof.proofId, "").then(data => {
      if (!Array.isArray(data.stages)) throw new Error("Receipt unavailable");
      if (active) setReceipt(data);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, proof.proofId, available, retry]);
  const received = receipt?.stages.find(stage => stage.type === "RECEIPT" && stage.finalizedAt);
  const pending = receipt?.stages.some(stage => stage.type === "RECEIPT" && !stage.finalizedAt);
  const latest = [...(proof.shipmentObservations?.events ?? [])].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const report = latest ? latest.eventType.toLowerCase().replaceAll("_", " ").replace(/^./, value => value.toUpperCase()) : "No carrier report recorded";
  const receiptLabel = !ordinary ? "Recorded in the custody workflow" : proof.status !== "FINALIZED" ? "Not recorded"
    : !api || !participant || error ? "Status unavailable" : !receipt ? "Loading receipt status…"
    : received ? `Receipt recorded ${formatWhen(received.finalizedAt)}` : pending ? "Recording in progress · not finalized" : "Not recorded";

  return <div className="record-receipt stack">
    <p className="panel-eyebrow">BUYER RECEIPT</p>
    <h3>Your shipment record</h3>
    <p>A seller can share selected order details and reviewed media in a read-only receipt.</p>
    <dl className="record-receipt-details">
      <div><dt>Order</dt><dd>{[proof.transaction.itemTitle || "Untitled item", orderReferenceLabel(proof.transaction.externalReference)].filter(Boolean).join(" · ")}</dd></div>
      <div><dt>Purchase details</dt><dd>{[quantityLabel(proof.transaction.quantity), moneyLabel(proof.transaction.transactionValue, proof.transaction.currency)].filter(Boolean).join(" · ") || "Not provided"}</dd></div>
      <div><dt>Carrier report</dt><dd>{report}{latest && <span className="note">{[latest.provider, latest.source].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(" · ")} · {formatWhen(latest.occurredAt)}{latest.eventData.test === true ? " · Test tracking data" : ""}</span>}</dd></div>
      <div><dt>Buyer acknowledgment</dt><dd>{receiptLabel}</dd></div>
    </dl>
    {error && <p className="note" role="status">Receipt status couldn’t be loaded. <button className="text-link" onClick={() => setRetry(value => value + 1)}>Retry receipt status</button></p>}
    <button className="btn btn-secondary" onClick={onReviewEvidence}>Review the recorded evidence</button>
    {role === "SELLER" && onReviewSharing && <button className="btn btn-secondary" disabled={busy} onClick={onReviewSharing}>Choose evidence for the buyer receipt</button>}
    {available && onOpenReceipt && <button className="btn btn-secondary" disabled={busy} onClick={onOpenReceipt}>{role === "BUYER" ? "Document receipt or return" : "Manage receipt and returns"}</button>}
    {!ordinary && <p className="note">Receiving and return evidence are recorded through this Proof’s custody steps.</p>}
    {ordinary && proof.status !== "FINALIZED" && <p className="note">Receipt and return recording becomes available after the packing Proof is finalized.</p>}
    <p className="note">Viewing a receipt does not acknowledge delivery, accept an item’s condition, or waive a return.</p>
  </div>;
}
