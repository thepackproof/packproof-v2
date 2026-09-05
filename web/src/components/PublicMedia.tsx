import { useEffect, useState } from "react";
import type { PublicProofView } from "../api/types";
export function PublicMedia({
  media,
  load,
}: {
  media: NonNullable<PublicProofView["evidence"]>[number];
  load: (id: string) => Promise<Blob>;
}) {
  const [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return (
    <section className="section stack">
      <h2>{media.slot} recording</h2>
      {url ? (
        media.contentType?.startsWith("video/") ? (
          <video className="capture-preview" controls playsInline src={url} />
        ) : (
          <img className="capture-preview" src={url} alt="Submitted evidence" />
        )
      ) : (
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load(media.evidenceId)
              .then((blob) => setUrl(URL.createObjectURL(blob)))
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Loading recording…" : "View recording"}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
