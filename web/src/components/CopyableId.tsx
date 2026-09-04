import { useState } from "react";
import { shortId } from "../format";

export function CopyableId(props: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="copyable">
      <code className="mono" title={props.value}>
        {status === "failed" ? props.value : shortId(props.value)}
      </code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.value);
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
        }}
      >
        {status === "copied" ? "Copied" : `Copy ${props.label}`}
      </button>
      {status === "failed" ? <span role="status">Select and copy the full value above.</span> : null}
    </span>
  );
}
