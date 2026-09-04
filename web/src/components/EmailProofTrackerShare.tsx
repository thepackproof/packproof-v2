import { useMemo, useState, type FormEvent } from "react";
import {
  PackProofApi,
  type ProofEmailPreference,
  type ProofEmailSubscriptionView,
} from "../api/client";
import { loadSession } from "../auth/session";

export function EmailProofTrackerShare(props: { proofId: string; disabled?: boolean }) {
  const [email, setEmail] = useState("");
  const [preference, setPreference] = useState<ProofEmailPreference>("IMPORTANT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    subscription: ProofEmailSubscriptionView;
    emailDeliveryConfigured: boolean;
    sent: number;
  } | null>(null);

  const api = useMemo(() => {
    const session = loadSession();
    if (!session) return null;
    return new PackProofApi({
      baseUrl: session.apiBaseUrl,
      getToken: () => loadSession()?.token ?? null,
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || busy) return;
    const recipient = email.trim();
    if (!recipient) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const created = await api.createProofEmailSubscription(props.proofId, {
        email: recipient,
        preference,
        scope: "SUMMARY",
      });
      setResult({
        subscription: created.subscription,
        emailDeliveryConfigured: created.emailDeliveryConfigured,
        sent: created.delivery.sent,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share this Proof by email.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section stack" aria-labelledby="email-proof-tracker-title">
      <div>
        <h2 id="email-proof-tracker-title">Email live Proof</h2>
        <p className="note">
          Send a secure, view-only tracker. The same link follows the Proof as packing,
          shipment, delivery, and finalization are recorded.
        </p>
      </div>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Recipient email</span>
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            disabled={props.disabled || busy}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="buyer@example.com"
          />
        </label>
        <label className="field">
          <span>Email updates</span>
          <select
            value={preference}
            disabled={props.disabled || busy}
            onChange={(event) => setPreference(event.target.value as ProofEmailPreference)}
          >
            <option value="IMPORTANT">Important updates</option>
            <option value="ALL">All tracker milestones</option>
            <option value="FINAL_ONLY">Finalization only</option>
          </select>
        </label>
        <button className="btn" type="submit" disabled={props.disabled || busy || !email.trim()}>
          {busy ? "Sending…" : "Send live Proof"}
        </button>
      </form>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="banner" role="status">
          <strong>
            {result.emailDeliveryConfigured && result.sent > 0
              ? "Live Proof email sent."
              : result.emailDeliveryConfigured
                ? "Live Proof email queued for delivery."
                : "Live Proof sharing is ready, but email delivery is not configured on this environment."}
          </strong>
          <div className="meta" style={{ marginTop: 6 }}>
            {result.subscription.email} will receive {preferenceLabel(result.subscription.preference)}.
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            style={{ marginTop: 10 }}
            onClick={() => void navigator.clipboard.writeText(result.subscription.viewUrl)}
          >
            Copy secure tracker link
          </button>
        </div>
      ) : null}
    </section>
  );
}

function preferenceLabel(preference: ProofEmailPreference): string {
  switch (preference) {
    case "ALL":
      return "all tracker milestone updates";
    case "FINAL_ONLY":
      return "a finalization update";
    default:
      return "important tracker updates";
  }
}
