import { useEffect, useState } from "react";
import QRCode from "qrcode";
export function SharingCode({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, {
      width: 224,
      margin: 4,
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (active) setImage(value);
      })
      .catch(() => setImage(null));
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <section className="section stack">
      <h2>Share this viewing link</h2>
      <p className="note">
        This link expires in seven days. It grants the viewing access you selected.
      </p>
      {image ? (
        <img src={image} width={224} height={224} alt="QR code for this Proof viewing link" />
      ) : null}
      <a className="secret-value" href={url}>
        {url}
      </a>
      <div className="btn-row">
        <a
          className="btn btn-secondary"
          href={`mailto:?subject=PackProof&body=${encodeURIComponent(url)}`}
        >
          Open email draft
        </a>
        <a className="btn btn-secondary" href={`sms:?body=${encodeURIComponent(url)}`}>
          Open text message
        </a>
      </div>
    </section>
  );
}
