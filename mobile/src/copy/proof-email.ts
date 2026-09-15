export function proofEmailDeliveryMessage(payload: { emailDeliveryConfigured?: boolean; delivery?: { sent?: number }; subscription?: { email?: string } }, requestedEmail: string): string {
  const email = payload.subscription?.email || requestedEmail;
  if (payload.emailDeliveryConfigured === false) return `Tracker created for ${email}. Email delivery is not configured on this environment yet.`;
  if (payload.emailDeliveryConfigured === true && Number(payload.delivery?.sent) > 0) return `Live Proof emailed to ${email}.`;
  if (payload.emailDeliveryConfigured === true) return `Live Proof email queued for ${email}.`;
  return `Tracker created for ${email}. Email delivery has not been confirmed.`;
}
export function proofEmailTrackerLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
