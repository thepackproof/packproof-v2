import { useEffect } from "react";
import type { PublicProofView } from "../api/types";
import { EvidencePreview, mediaType, useEvidenceBlob } from "./EvidencePreview";
import { Notice } from "./Notice";

export function PublicMedia({ media, load, autoOpen = false, playbackScope }: { playbackScope?: string; autoOpen?: boolean; media: NonNullable<PublicProofView["evidence"]>[number]; load: (id: string) => Promise<Blob> }) {
  const playbackKey = playbackScope ? `packproof.shared.playback.${playbackScope}.${media.evidenceId}.${media.derivativeId || "original"}` : null;
  const preview = useEvidenceBlob(`${media.evidenceId}:${media.slot}:${media.derivativeId||"original"}`);
  const type = mediaType(media.contentType);
  const label = type === "application/pdf" ? "document" : type.startsWith("video/") ? "recording" : "evidence";
  useEffect(() => { if (autoOpen) void preview.open(media.evidenceId, media.contentType, load); }, [autoOpen, media.evidenceId, media.derivativeId]);
  return <section className="section stack">
    {!autoOpen && <h2>{media.slot} {label}</h2>}
    {preview.url ? <EvidencePreview url={preview.url} contentType={preview.contentType} evidenceId={media.evidenceId} title={media.label||`${media.slot} ${label}`} original={media.representation!=="DERIVATIVE"}
      onLoadedMetadata={event => {
        if (!playbackKey) return;
        try { const time = Number(sessionStorage.getItem(playbackKey)); if (Number.isFinite(time) && time >= 0) event.currentTarget.currentTime = Math.min(time, Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : time); } catch { /* Playback remains available without storage. */ }
      }}
      onTimeUpdate={event => { if (playbackKey) try { sessionStorage.setItem(playbackKey, String(event.currentTarget.currentTime)); } catch { /* Optional position persistence. */ } }} /> : <button className="btn" disabled={preview.busy} onClick={() => void preview.open(media.evidenceId, media.contentType, load)}>{preview.busy ? `Loading ${label}…` : `View ${label}`}</button>}
    {preview.error && <Notice kind="error" title="Evidence couldn’t be opened">{preview.error}</Notice>}
  </section>;
}
