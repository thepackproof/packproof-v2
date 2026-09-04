import { useEffect, useRef, useState } from "react";

export function EvidenceViewer(props: {
  evidenceId: string;
  contentType?: string;
  load: (evidenceId: string) => Promise<Blob>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => {
    generation.current++;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  async function open() {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const blob = await props.load(props.evidenceId);
      if (current !== generation.current) return;
      const next = URL.createObjectURL(blob);
      objectUrl.current = next;
      setUrl(next);
    } catch {
      if (current === generation.current) setError("Evidence could not be loaded. Check your connection and try again.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const video = props.contentType?.startsWith("video/");
  const image = /^(image\/(jpeg|png|webp|gif))$/.test(props.contentType ?? "");
  const audio = props.contentType?.startsWith("audio/");
  const extensions: Record<string, string> = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
  };
  const filename = `packproof-${props.evidenceId}.${extensions[props.contentType ?? ""] ?? "bin"}`;
  return (
    <div className="evidence-viewer">
      {!url ? (
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void open()}>
          {loading ? "Loading evidence…" : error ? "Retry evidence" : video ? "Watch recording" : image ? "View photo" : "Open evidence"}
        </button>
      ) : (
        <>
          {video ? <video className="evidence-media" src={url} controls playsInline preload="metadata" aria-label="Packing evidence recording" /> : null}
          {image ? <img className="evidence-media" src={url} alt="Committed Proof evidence" /> : null}
          {audio ? <audio src={url} controls preload="metadata" aria-label="Proof audio evidence" /> : null}
          <div className="btn-row">
            <a className="btn btn-secondary" href={url} download={filename}>Download original</a>
            <button type="button" className="btn btn-secondary" onClick={() => {
              generation.current++;
              if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
              objectUrl.current = null;
              setUrl(null);
            }}>Close evidence</button>
          </div>
        </>
      )}
      {error ? <p className="note" role="alert">{error}</p> : null}
    </div>
  );
}
