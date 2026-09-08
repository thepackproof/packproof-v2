import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { AccessLinkView, CanonicalProof } from "../api/types";
import { recordProofStatus } from "@packproof/copy/proof-record";
import { SharedProofRecord, type SharedProofView } from "./SharedProofRecord";
import { SharingCode } from "./SharingCode";
import { recordStudyInteraction } from "../analytics/study-capture";

type Preview = SharedProofView & { disclosure: NonNullable<SharedProofView["disclosure"]> };
export function PrivacySharePanel({ api, proof, currentUserId }: { api: PackProofApi; proof: CanonicalProof; currentUserId?: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [grant, setGrant] = useState<AccessLinkView | null>(null);
  const [links, setLinks] = useState<AccessLinkView[]>([]);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // A refreshed record must be previewed again before a new grant is approved.
  useEffect(() => { setPreview(null); }, [proof.updatedAt]);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await fn(); }
    catch (caught) { if (active.current) setError(caught instanceof Error ? caught.message : "Sharing could not be completed."); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function refreshLinks() {
    const result = await api.featureRequest<{ accessLinks: AccessLinkView[] }>(proof.proofId, "access-links");
    if (active.current) setLinks(result.accessLinks);
  }
  async function prepare() {
    const result = await api.featureRequest<Preview>(proof.proofId, "disclosure/preview", "POST", { purpose: "SHARED_PROOF" });
    if (active.current) { setPreview(result); setGrant(null); }
  }
  async function loadMedia(id: string) {
    const media = preview?.evidence?.find(item => item.evidenceId === id);
    if (!media) throw new Error("This recording is not in the current Proof preview.");
    return media.stageId
      ? api.featureDownload(proof.proofId, `lifecycle/stages/${media.stageId}/evidence/${id}`)
      : api.getEvidenceBlob(proof.proofId, id);
  }
  return <section className="section stack share-proof-panel" aria-label="Share Proof">
    <h2>Share Proof</h2>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="share-proof-identity"><strong>{proof.transaction.itemTitle || "This Proof"}</strong><span>{recordProofStatus(proof.status)}</span></div>
    <button className="share-proof-preview-link" disabled={busy} onClick={() => void run(prepare)}>Preview Proof <span aria-hidden="true">›</span></button>
    <label className="share-proof-expiry"><span>Link expires</span><select aria-label="Link expires" value={days} disabled={busy || Boolean(grant)} onChange={event => setDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
    <details onToggle={event => { if (event.currentTarget.open) void run(refreshLinks); }}>
      <summary>Manage shared links</summary>
      <div className="stack">{links.filter(item => !item.revokedAt).map(item => <div key={item.accessLinkId} className="share-link-row"><span>{item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleDateString()}` : "No expiry"}</span><button className="text-link" disabled={busy} onClick={() => void run(async () => { await api.featureRequest(proof.proofId, `access-links/${item.accessLinkId}`, "DELETE"); if (grant?.accessLinkId === item.accessLinkId) setGrant(null); await refreshLinks(); })}>Revoke link</button></div>)}{!busy && !links.some(item => !item.revokedAt) && <p className="note">No active links.</p>}</div>
    </details>
    {preview && !grant && <div className="stack share-proof-review">
      <SharedProofRecord proof={preview} loadMedia={loadMedia} />
      <p>{preview.disclosure.sharingNotice || "Anyone with this link can view this Proof, its original recordings, and future updates. Review the recordings before sharing."}</p>
      <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const result = await api.featureRequest<AccessLinkView>(proof.proofId, "disclosure/grants", "POST", { purpose: "SHARED_PROOF", originalsReviewed: true, previewHash: preview.disclosure.viewHash, expiresAt: new Date(Date.now() + days * 86400000).toISOString() });
        if (currentUserId && result.accessLinkId) void recordStudyInteraction(api, currentUserId, 'share_created');
        if (active.current) { setGrant(result); setNotice("Share link created."); }
      })}>{busy ? "Creating link…" : "Create share link"}</button>
    </div>}
    {!preview && !grant && <button className="btn" disabled={busy} onClick={() => void run(prepare)}>{busy ? "Loading preview…" : "Create share link"}</button>}
    {grant && <div className="stack"><SharingCode url={grant.url || `${window.location.origin}/p/${grant.token}`} />
      <details><summary>Email this Proof</summary><form className="stack" onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api.featureRequest<{ emailDeliveryConfigured?: boolean; emailSent?: boolean }>(proof.proofId, "email-subscriptions", "POST", { email, preference: "IMPORTANT", recipientGrantId: grant.accessLinkId }); setNotice(result.emailDeliveryConfigured === false ? "Email delivery is unavailable. You can copy the share link." : result.emailSent ? "Proof email sent." : "Proof email queued."); }); }}><label className="field"><span>Invited participant’s verified email</span><input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><button className="btn btn-secondary" disabled={busy || !email}>Send Proof email</button></form></details>
    </div>}
  </section>;
}
