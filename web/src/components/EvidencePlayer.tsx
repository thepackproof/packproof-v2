import type { CanonicalProof } from "../api/types";
import { EvidencePreview, mediaType, useEvidenceBlob } from "./EvidencePreview";
import { Glyph } from "../site/Brand";
import { Notice } from "./Notice";

export function EvidencePlayer(props: { proof: CanonicalProof; load?: (id: string) => Promise<Blob> }) {
  const evidence = props.proof.evidence.filter(e => e.validationStatus === "COMMITTED");
  const preview = useEvidenceBlob(props.proof.proofId);
  if (!evidence.length || !props.load) return null;
  const current = evidence.find(e => e.evidenceId === preview.selectedId);
  return <section className="section stack evidence-player">
    <div className="panel-heading"><div><span className="panel-eyebrow"><Glyph name="film" size={15} /> THE DETAILS THAT MATTER</span><h2>Packing evidence</h2></div><span className="evidence-count">{evidence.length} files</span></div>
    {preview.url && current ? <EvidencePreview url={preview.url} contentType={preview.contentType} evidenceId={current.evidenceId} title={preview.contentType === "application/pdf" ? "Document evidence" : "Packing evidence"} /> : <div className="evidence-placeholder" aria-busy={preview.busy}><span><Glyph name={preview.busy ? "clock" : "film"} size={28} /></span><strong>{preview.busy ? "Loading your evidence…" : "A closer look at the record."}</strong><p>Select a file to review the submitted evidence.</p></div>}
    <div className="evidence-file-tabs" aria-label="Evidence files">{evidence.map((item, index) => {
      const type = mediaType(item.contentType);
      const label = type === "application/pdf" ? "View document" : type.startsWith("video/") ? "Play video" : type.startsWith("image/") ? "View image" : "View file";
      return <button type="button" key={item.evidenceId} aria-pressed={current?.evidenceId === item.evidenceId} onClick={() => void preview.open(item.evidenceId, item.contentType, props.load!)}><Glyph name={type === "application/pdf" ? "file" : type.startsWith("video/") ? "film" : "box"} size={17} />{label}{evidence.length > 1 ? ` ${index + 1}` : ""}{preview.busy && current?.evidenceId === item.evidenceId ? " · Loading…" : ""}</button>;
    })}</div>
    {preview.error && <Notice kind="error" title="Evidence couldn’t be opened">{preview.error}</Notice>}
  </section>;
}
