import { useEffect, useState } from 'react';

interface ConfigurationApprovalProps {
  proposalSha256?: string | null;
  sourceContract?: { schema: string; historyPolicy?: { observedAt: string } | null } | null;
  busy: boolean;
  approved?: boolean;
  error?: string | null;
  notice?: string | null;
  onApprove: () => void;
}

const reviewWindowMs = 30 * 60 * 1000;
const freshReview = 'Reopen the selected local report on the source computer and request a fresh review.';

export function configurationReviewDeadline(contract: ConfigurationApprovalProps['sourceContract']) {
  if (contract?.schema !== 'packproof.scheduled-csv/v2') return null;
  return Date.parse(contract.historyPolicy?.observedAt ?? '') + reviewWindowMs;
}

export function ConfigurationApproval({ proposalSha256, sourceContract, busy, approved = false, error, notice, onApprove }: ConfigurationApprovalProps) {
  const [consentedDigest, setConsentedDigest] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const deadline = configurationReviewDeadline(sourceContract);
  const invalidDigest = !proposalSha256 || !/^[a-f0-9]{64}$/.test(proposalSha256);
  const invalidDeadline = deadline !== null && !Number.isFinite(deadline);
  const expired = deadline !== null && Date.now() > deadline;
  const unavailable = invalidDigest || invalidDeadline || expired;
  const consent = !!proposalSha256 && consentedDigest === proposalSha256;

  useEffect(() => {
    if (deadline === null || !Number.isFinite(deadline)) return;
    const remaining = deadline - Date.now();
    if (remaining < 0) return;
    const updateClock = () => setNow(Date.now());
    // The API accepts the exact deadline. Recheck after that millisecond.
    const timer = window.setTimeout(updateClock, Math.min(remaining + 1, 2_147_483_647));
    window.addEventListener('focus', updateClock);
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', updateClock);
      document.removeEventListener('visibilitychange', updateClock);
    };
  }, [deadline, now]);

  function approve() {
    if (deadline !== null && Date.now() > deadline) {
      setNow(Date.now());
      return;
    }
    if (consent && !busy && !unavailable && !approved) onApprove();
  }

  return <div className="source-approval-action">
    {unavailable && !approved && <p role="status" className="records-notice warning">
      {expired ? 'This configuration review expired after 30 minutes.' : 'This configuration review is incomplete.'} {freshReview}
    </p>}
    <label className="agent-check">
      <input type="checkbox" checked={consent && !unavailable} disabled={busy || unavailable || approved}
        onChange={event => setConsentedDigest(event.target.checked ? proposalSha256 ?? null : null)}/>
      Approve this exact configuration, initial whole-original upload and stated history scope. Previous previews and verification are invalidated.
    </label>
    <button type="button" className="records-button" disabled={!consent || busy || unavailable || approved} onClick={approve}>
      {approved ? 'Configuration approved' : busy ? 'Saving approval…' : 'Approve configuration'}
    </button>
    {error && <p role="alert" className="records-error-text">{error}</p>}
    {notice && <p role="status" className="records-notice neutral">{notice}</p>}
  </div>;
}
