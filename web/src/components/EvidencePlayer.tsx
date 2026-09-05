import { useEffect, useState } from "react";
import type { CanonicalProof } from "../api/types";

export function EvidencePlayer(props: {
  proof: CanonicalProof;
  load?: (id: string) => Promise<Blob>;
}) {
  const evidence = props.proof.evidence.filter(
    (e) =>
      e.validationStatus === "COMMITTED" &&
      (e.contentType?.startsWith("video/") || e.contentType?.startsWith("image/")),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(null);
    setUrl(null);
    setError(null);
  }, [props.proof.proofId]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (!evidence.length || !props.load) return null;
  const current = evidence.find((e) => e.evidenceId === selected);
  return (
    <section className="section stack evidence-player">
      <h2>Packing evidence</h2>
      {url && current ? (
        current.contentType?.startsWith("video/") ? (
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label="Recorded packing evidence"
          />
        ) : (
          <img src={url} alt="Recorded shipment evidence" />
        )
      ) : (
        <p className="note">See the item, packing, and seal in the submitted recording.</p>
      )}
      <div className="btn-row">
        {evidence.map((item, index) => (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            key={item.evidenceId}
            onClick={() => {
              setBusy(true);
              setError(null);
              void props.load!(item.evidenceId)
                .then((blob) => {
                  setUrl(URL.createObjectURL(blob));
                  setSelected(item.evidenceId);
                })
                .catch((e) => setError(e instanceof Error ? e.message : "Evidence unavailable"))
                .finally(() => setBusy(false));
            }}
          >
            {busy
              ? "Loading…"
              : `${item.contentType?.startsWith("video/") ? "Play video" : "View image"}${evidence.length > 1 ? ` ${index + 1}` : ""}`}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="banner banner-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
