import { useEffect, useRef, useState, type ReactNode } from "react";
import { moneyLabel, orderReferenceLabel, quantityLabel } from "@packproof/copy/format";
import { providerDisplay } from "@packproof/copy/status";
import type { ProofPresentation } from "../../../backend/src/domain/proof-presentation";
import { presentProof } from "../proof-presentation";
import type { PackProofApi } from "../api/client";
import type { CanonicalProof, ChronologyEntry } from "../api/types";
import { formatWhen } from "../format";
import { useViewState } from "../navigation-context";
import { Glyph } from "../site/Brand";
import { EvidencePreview, mediaType, useEvidenceBlob } from "./EvidencePreview";
import { ProofTimeline } from "./ProofTimeline";
import { ShipmentTracking } from "./ShipmentTracking";
import { StatusBadge } from "./StatusBadge";
import { PreservationStatus } from "./PreservationStatus";

const tabs = ["Recording", "Activity", "Tracking"] as const;
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

function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The live counterpart of the public SampleProof, using only this participant's sources. */
export function WorkspaceProofRecord(props: {
  proof: CanonicalProof;
  presentation?: ProofPresentation;
  currentUserId: string;
  role?: string;
  api?: PackProofApi;
  busy?: boolean;
  loadEvidence?: (id: string) => Promise<Blob>;
  onOpenEvent?: (entry: ChronologyEntry) => void;
  onOpenReceipt?: () => void;
  onReviewSharing?: () => void;
  trackingTools?: ReactNode;
  nextAction?: ReactNode;
}) {
  const { proof } = props;
  const scope = `${props.api?.recoveryScope || location.origin}.${props.currentUserId}.${proof.proofId}`;
  const [savedTab, setTab] = useViewState<RecordTab>(`proof.${scope}.recordTab`, "Recording");
  const tab = tabs.includes(savedTab) ? savedTab : "Recording";
  const record = useRef<HTMLElement>(null);
  const controls = useRef<Array<HTMLButtonElement | null>>([]);
  const title = proof.transaction.itemTitle?.trim() || "Untitled item";
  const reference = orderReferenceLabel(proof.transaction.externalReference);

  function select(next: RecordTab, focus = false) {
    if (next !== "Recording") record.current?.querySelectorAll<HTMLMediaElement>("video,audio").forEach(media => media.pause());
    setTab(next);
    const button = controls.current[tabs.indexOf(next)];
    if (focus) button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  return <article ref={record} className="workspace-proof-record" aria-label="Proof record" data-context-anchor={`proof-record-${proof.proofId}`}>
    <header className="record-top">
      <div><h2>{title}</h2>{reference && <p>{reference}</p>}<details className="record-order-details"><summary>Order details</summary><p>{[quantityLabel(proof.transaction.quantity), moneyLabel(proof.transaction.transactionValue, proof.transaction.currency)].filter(Boolean).join(" · ") || "No additional order details"}</p><p>{proof.transaction.provenance ? `From ${providerDisplay(proof.transaction.provenance.provider)}. Imported order details are read-only.` : "Order details supplied by a participant."}</p>{proof.transaction.provenance?.importedAt && <p>Imported {formatWhen(proof.transaction.provenance.importedAt)}</p>}</details></div>
      <StatusBadge label={(props.presentation || presentProof(proof, props.currentUserId)).displayStatus} />
    </header>
    <p className="record-source-note">Shipment: {proof.shipmentObservations?.latest?.eventType?.replaceAll("_", " ").toLowerCase() || "No carrier update yet"}</p>
    {props.nextAction}
    {props.api && <PreservationStatus api={props.api} proofId={proof.proofId} />}
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
    <div className="record-body" hidden={tab !== "Recording"} role="tabpanel" tabIndex={0} id={`record-${proof.proofId}-Recording-panel`} aria-labelledby={`record-${proof.proofId}-Recording-tab`}>
      <RecordEvidence key={scope} scope={scope} proof={proof} api={props.api} load={props.loadEvidence} />
    </div>
    <div className="record-body" hidden={tab !== "Activity"} role="tabpanel" tabIndex={0} id={`record-${proof.proofId}-Activity-panel`} aria-labelledby={`record-${proof.proofId}-Activity-tab`}>
      {tab === "Activity" && <>
        <ProofTimeline entries={proof.chronology ?? []} audit={proof.events ?? []} finalizedAt={proof.finalizedAt} onSelect={props.onOpenEvent} />
        {proof.status === "FINALIZED" && <p className="note record-source-note">The packing record was locked {formatWhen(proof.finalizedAt)}. Later carrier reports and receipt or return stages are added separately.</p>}
      </>}
    </div>
    <div className="record-body" hidden={tab !== "Tracking"} role="tabpanel" tabIndex={0} id={`record-${proof.proofId}-Tracking-panel`} aria-labelledby={`record-${proof.proofId}-Tracking-tab`}>
      {tab === "Tracking" && <div className="stack">
        <ShipmentTracking events={proof.shipmentObservations?.events ?? []} carrier={proof.transaction.shipping?.carrier} trackingNumber={proof.transaction.shipping?.trackingNumber} registration={proof.captureShipping?.registration} sync={proof.shipmentSync} />
        {props.trackingTools}
      </div>}
    </div>
  </article>;
}

function RecordEvidence({ proof, api, load, scope }: { proof: CanonicalProof; api?: PackProofApi; load?: (id: string) => Promise<Blob>; scope: string }) {
  const evidence = [
    ...proof.evidence.filter(item => item.validationStatus === "COMMITTED").map(item => ({ ...item, stageId: null as string | null })),
    ...(proof.commerceStages ?? []).flatMap(stage => stage.evidence.filter(item => item.committedAt).map(item => ({ ...item, stageId: stage.stageId, evidenceType: stage.type, validationStatus: "COMMITTED", digest: null }))),
  ];
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
    if (!item || (!item.stageId && !load) || (item.stageId && !api)) return;
    pendingSeek.current = at ?? restoreTime(id);
    setSelected(id);
    if (current?.evidenceId === id && preview.url && video.current) {
      video.current.currentTime = Math.min(pendingSeek.current, Number.isFinite(video.current.duration) ? video.current.duration : pendingSeek.current);
      pendingSeek.current = null;
      video.current.focus({ preventScroll: true });
      return;
    }
    const loader = item.stageId ? () => api!.featureDownload(proof.proofId, `lifecycle/stages/${item.stageId}/evidence/${id}`) : load!;
    await preview.open(id, item.contentType, loader);
  }

  useEffect(() => {
    if ((!load && !api) || !evidence.length) return;
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

  const visibleBookmarks = bookmarks.filter(bookmark => !current?.stageId && !bookmark.stageId && bookmark.evidenceId === current?.evidenceId
    && bookmark.sourceHash === (current?.digest?.sha256 || current?.sha256) && Boolean(bookmark.sourceHash)
    && typeof bookmark.startMs === "number" && Number.isFinite(bookmark.startMs) && bookmark.startMs >= 0
    && typeof bookmark.endMs === "number" && Number.isFinite(bookmark.endMs) && bookmark.endMs > bookmark.startMs
    && !bookmarks.some(replacement => replacement.supersedesId === bookmark.anchorId))
    .sort((a, b) => a.startMs! - b.startMs!);

  if (!evidence.length) return <div className="evidence-placeholder"><span><Glyph name="film" size={28} /></span><strong>Recording has not been added yet</strong><p>Record the item being packed and sealed.</p></div>;
  if (!load && !api) return <div className="evidence-placeholder"><span><Glyph name="film" size={28} /></span><strong>{evidence.length} saved file{evidence.length === 1 ? "" : "s"}</strong><p>Media playback isn’t available in this view.</p></div>;

  return <div className="record-evidence stack">
    {preview.url && current ? <EvidencePreview
      url={preview.url}
      contentType={preview.contentType}
      evidenceId={current.evidenceId}
      title={preview.contentType.startsWith("video/") && ["SELLER_EVIDENCE", "FULFILLMENT_CAPTURE"].includes(current.evidenceType) ? `Packing ${proof.transaction.itemTitle?.trim() || "the item"}` : current.stageId ? `${current.evidenceType === "RECEIPT" ? "Receipt" : "Return"} recording` : "Recorded evidence"}
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
      {visibleBookmarks.length > 0 ? <div className="record-chapters" aria-label="Recorded source moments">{visibleBookmarks.map(bookmark => <button type="button" key={bookmark.anchorId} onClick={() => void open(bookmark.evidenceId!, bookmark.startMs! / 1000)} title={`Source: ${bookmark.sourceCategory.replaceAll("_", " ").toLowerCase()}`}>{elapsed(bookmark.startMs!)} · {bookmark.label}</button>)}</div> : null}
    </>}
    {(proof.attestations ?? []).filter(statement => !statement.relatedEvidenceId || statement.relatedEvidenceId === current?.evidenceId).map(statement => <section className="record-declaration" key={statement.attestationId} aria-label="Participant statement">
      <h3>{proof.participants.find(participant => participant.userId === statement.attestedBy)?.role === "SELLER" ? "Seller declaration" : "Participant statement"}</h3>
      <p>{statement.statementText || (statement.statement === "PACKED_DESCRIBED_ITEM" ? "Seller attested to packing the described item" : statement.statement)}</p>
      <p className="note">Recorded {formatWhen(statement.createdAt)}. This is the participant’s declaration about the shipment.</p>
    </section>)}
    {bookmarkError && <p className="note" role="status">{bookmarkError} <button className="text-link" onClick={() => setRetry(value => value + 1)}>Retry bookmarks</button></p>}
  </div>;
}
