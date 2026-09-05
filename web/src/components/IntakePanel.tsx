import { useState } from "react";
import type { IntakePreview } from "@packproof/copy/order-intake";

export function IntakePanel(props: {
  onPreview: (text: string) => Promise<IntakePreview>;
  onReview: (preview: IntakePreview) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="section stack"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void props
          .onPreview(text)
          .then(props.onReview)
          .catch((e) => setError(e instanceof Error ? e.message : "Could not read this order"))
          .finally(() => setBusy(false));
      }}
    >
      <h2>Paste an order</h2>
      <p className="note">
        Copy an order confirmation or forwarded email. Review the details before creating your
        Proof.
      </p>
      <label className="field">
        <span>Order confirmation</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={20000}
          rows={8}
          placeholder={"Order: 12345\nItem: Trading card\nTotal: USD 3000\nTracking: …"}
        />
      </label>
      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn" disabled={busy || !text.trim()}>
        {busy ? "Reading order…" : "Review order details"}
      </button>
    </form>
  );
}
