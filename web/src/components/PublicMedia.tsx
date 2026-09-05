import type { PublicProofView } from "../api/types";
import { EvidencePreview, mediaType, useEvidenceBlob } from "./EvidencePreview";
import { Notice } from "./Notice";

export function PublicMedia({ media, load }: { media: NonNullable<PublicProofView["evidence"]>[number]; load: (id: string) => Promise<Blob> }) {
  const preview = useEvidenceBlob(`${media.evidenceId}:${media.slot}:${media.derivativeId||"original"}`);
  const type = mediaType(media.contentType);
  const label = type === "application/pdf" ? "document" : type.startsWith("video/") ? "recording" : "evidence";
  return <section className="section stack">
    <h2>{media.slot} {label}</h2>
    {preview.url ? <EvidencePreview url={preview.url} contentType={preview.contentType} evidenceId={media.evidenceId} title={media.label||`${media.slot} ${label}`} original={media.representation!=="DERIVATIVE"} /> : <button className="btn" disabled={preview.busy} onClick={() => void preview.open(media.evidenceId, media.contentType, load)}>{preview.busy ? `Loading ${label}…` : `View ${label}`}</button>}
    {preview.error && <Notice kind="error" title="Evidence couldn’t be opened">{preview.error}</Notice>}
  </section>;
}
