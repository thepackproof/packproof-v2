import { useEffect, useRef, useState, type Ref, type ReactEventHandler } from "react";
import { Glyph } from "../site/Brand";

export function mediaType(contentType?: string | null) {
  return (contentType ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
}

export function useEvidenceBlob(identity: string) {
  const generation = useRef(0);
  const ownedUrl = useRef<string | null>(null);
  function releaseUrl() { if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current); ownedUrl.current = null; }
  const [state, setState] = useState<{ url: string | null; selectedId: string | null; busy: boolean; error: string | null; contentType: string }>({ url: null, selectedId: null, busy: false, error: null, contentType: "application/octet-stream" });
  useEffect(() => {
    generation.current++;
    releaseUrl();
    setState({ url: null, selectedId: null, busy: false, error: null, contentType: "application/octet-stream" });
    return () => { generation.current++; releaseUrl(); };
  }, [identity]);
  async function open(id: string, contentType: string | null | undefined, load: (id: string) => Promise<Blob>) {
    const request = ++generation.current;
    releaseUrl();
    setState({ url: null, selectedId: id, busy: true, error: null, contentType: mediaType(contentType) });
    try {
      const blob = await load(id);
      if (request !== generation.current) return;
      const effectiveType = mediaType(contentType?.trim() || blob.type);
      const url = URL.createObjectURL(new Blob([blob], { type: effectiveType }));
      ownedUrl.current = url;
      setState({ url, selectedId: id, busy: false, error: null, contentType: effectiveType });
    } catch (error) {
      if (request === generation.current) setState({ url: null, selectedId: id, busy: false, error: error instanceof Error ? error.message : "Evidence is unavailable. Please try again.", contentType: mediaType(contentType) });
    }
  }
  return { ...state, open };
}

export function EvidencePreview({ url, contentType, evidenceId, title = "Recorded evidence", original = true, provenanceLabel, videoRef, onLoadedMetadata, onTimeUpdate }: { url: string; contentType?: string | null; evidenceId: string; title?: string; original?: boolean; provenanceLabel?: string; videoRef?: Ref<HTMLVideoElement>; onLoadedMetadata?: ReactEventHandler<HTMLVideoElement>; onTimeUpdate?: ReactEventHandler<HTMLVideoElement> }) {
  const type = mediaType(contentType);
  const pdf = type === "application/pdf";
  const extensions: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
  const filename = `packproof-${evidenceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extensions[type] || "bin"}`;
  return <div className={`document-viewer ${pdf ? "pdf-viewer" : ""}`}>
    <div className="document-toolbar"><span className="document-file-icon"><Glyph name={pdf ? "file" : type.startsWith("video/") ? "film" : "box"} size={19} /></span><div><strong>{title}</strong><span>{pdf ? "PDF document" : type.startsWith("video/") ? "Video evidence" : type.startsWith("image/") ? "Image evidence" : "Original file"} · {provenanceLabel || (original ? "Original evidence" : "Reviewed redacted copy")}</span></div><a href={url} download={filename} className="document-download" aria-label={original ? "Download original evidence" : "Download redacted copy"}><Glyph name="download" size={17} /><span>{original ? "Download original" : "Download redacted copy"}</span></a></div>
    <div className="document-canvas">{pdf ? <iframe title={`${title} PDF preview`} src={url} /> : type.startsWith("video/") ? <video key={url} ref={videoRef} src={url} controls playsInline preload="metadata" onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onTimeUpdate} aria-label="Recorded packing evidence" /> : type.startsWith("image/") ? <img src={url} alt="Recorded shipment evidence" /> : <div className="document-unsupported"><Glyph name="file" size={32} /><p>This file is available to download. A preview isn’t available for this format.</p></div>}</div>
    {pdf && <div className="document-footer"><span>Your browser provides the document controls.</span><a href={url} target="_blank" rel="noopener noreferrer">Open PDF in a new tab ↗</a><span>If the preview does not appear, download the original above.</span></div>}
  </div>;
}
