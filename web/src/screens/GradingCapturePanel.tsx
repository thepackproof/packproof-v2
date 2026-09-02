import { useState } from "react";
import { captureSlots } from "@packproof/copy/custody";

export function GradingCapturePanel(props: {
  recipe?: string | null;
  busy: boolean;
  onCommit: (files: Array<{ slot: string; file: File }>) => Promise<void>;
}) {
  const slots = captureSlots(props.recipe);
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const ready = slots.filter((slot) => slot.required).every((slot) => Boolean(files[slot.slot]));

  if (slots.length === 0) {
    return null;
  }

  return (
    <section className="section stack">
      <h2>Capture</h2>
      <p className="note">Add a photo or recording for each step, then continue. PackProof records what you submit.</p>
      {slots.map((slot) => (
        <label key={slot.slot} className="field">
          <span>{slot.prompt}</span>
          <input
            type="file"
            accept={slot.accept}
            disabled={props.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setFiles((current) => ({ ...current, [slot.slot]: file }));
            }}
          />
        </label>
      ))}
      <button
        className="btn"
        type="button"
        disabled={props.busy || !ready}
        onClick={() => {
          const payload = slots
            .map((slot) => {
              const file = files[slot.slot];
              return file ? { slot: slot.slot, file } : null;
            })
            .filter((row): row is { slot: string; file: File } => Boolean(row));
          void props.onCommit(payload);
        }}
      >
        {props.busy ? "Saving…" : "Save capture"}
      </button>
    </section>
  );
}
