import { useEffect, useState } from "react";
import QRCode from "qrcode";
export function SharingCode({ url, expiresAt, onValidate }: { url: string; expiresAt?: string | null; onValidate?: () => Promise<void> }) {
  const [image, setImage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, { width: 224, margin: 4, errorCorrectionLevel: "M" }).then(value => { if (active) setImage(value); }).catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [url]);
  async function handoff(share: boolean) {
    setBusy(true); setNotice(null); setError(null);
    try {
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error("This viewing link has expired. Create a current link.");
      await onValidate?.();
      if (share && navigator.share) {
        await navigator.share({ title: "PackProof", url });
        setNotice("Link handed to your share sheet.");
      } else {
        if (!navigator.clipboard?.writeText) throw new Error("Copying isn’t available in this browser. Select and copy the link below.");
        await navigator.clipboard.writeText(url);
        setNotice(navigator.onLine === false ? "Link copied. Pending changes will appear after sync." : "Link copied.");
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setNotice("Sharing dismissed.");
      else setError(caught instanceof Error ? caught.message : "The link could not be shared. Try Copy link.");
    } finally { setBusy(false); }
  }
  return <section className="section stack" aria-label="Viewing link">
    <h2>Your viewing link</h2>
    <p className="note">{expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}.` : expiresAt === null ? "This link has no scheduled expiry." : "Expiry follows the access you selected."} The link opens this same Proof as it develops.</p>
    {navigator.onLine === false && <p role="status">You’re offline. Pending changes will appear after sync; access changes can be checked when you reconnect.</p>}
    {image && <img src={image} width={224} height={224} alt="QR code for this Proof viewing link" />}
    <a className="secret-value" href={url}>{url}</a>
    <div className="btn-row">
      {typeof navigator.share === "function" && <button className="btn" disabled={busy} onClick={() => void handoff(true)}>Share link</button>}
      <button className="btn btn-secondary" disabled={busy} onClick={() => void handoff(false)}>Copy link</button>
    </div>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
