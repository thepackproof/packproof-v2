import { useEffect, useState } from "react";
export function CapturePreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const local = URL.createObjectURL(file);
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [file]);
  return url ? (
    <video
      className="capture-preview"
      src={url}
      controls
      playsInline
      preload="metadata"
      aria-label="Review packing recording before upload"
    />
  ) : null;
}
