export type Subscription = {
  subscriptionReference: string; status: string; currentPeriodEnd: string | null; trialEnd: string | null;
  cancelAtPeriodEnd: boolean; cancelAt: string | null; canceledAt: string | null; endedAt: string | null;
  nextCharge: { expectedAt: string | null; baseAmountMinor: number | null; currency: string | null; estimate: boolean } | null;
};
export type BillingStatus = { enabled: boolean; environment?: string; subscriptions: Subscription[]; pendingCheckout: string | null };
export type BillingOffer = { enabled: boolean; offer: null | { version: string; sha256: string; priceMinor: number; currency: string; interval: string; includedFinalizedProofs: number; maxRecordingBytes: number; maxRecordingSeconds: number } };
export type Invoice = { invoiceReference: string; status: string; currency: string; amountDueMinor: number; amountPaidMinor: number; createdAt: string };
export type InvoicePage = { enabled: boolean; invoices: Invoice[]; environment?: string; hasMore?: boolean; nextStartingAfter?: string | null };
export type Usage = { window: { start: string; end: string }; finalizedWithDurabilityReceipt: number; finalizedWithoutConfirmedDurability: number; recordedUsageUnits: number; message: string; currentOffer: null | { version: string; remaining: number; includedFinalizedProofs: number; period: { end: string } } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalDate = (value: unknown) => value === null || date(value);

export function readBillingStatus(value: unknown): BillingStatus {
  if (!object(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.subscriptions)) throw new Error('Your plan status is temporarily unavailable.');
  if (!value.enabled) return { enabled: false, subscriptions: [], pendingCheckout: null };
  if (value.pendingCheckout !== null && typeof value.pendingCheckout !== 'string') throw new Error('Your checkout status is unavailable.');
  for (const row of value.subscriptions) {
    if (!object(row) || typeof row.subscriptionReference !== 'string' || typeof row.status !== 'string' || typeof row.cancelAtPeriodEnd !== 'boolean' || ![row.currentPeriodEnd, row.trialEnd, row.cancelAt, row.canceledAt, row.endedAt].every(optionalDate)) throw new Error('Your subscription details are unavailable.');
    if (row.nextCharge !== null && (!object(row.nextCharge) || !optionalDate(row.nextCharge.expectedAt) || (row.nextCharge.baseAmountMinor !== null && !count(row.nextCharge.baseAmountMinor)) || (row.nextCharge.currency !== null && typeof row.nextCharge.currency !== 'string'))) throw new Error('Your next-charge details are unavailable.');
  }
  return value as BillingStatus;
}
export function readBillingOffer(value: unknown): BillingOffer {
  if (!object(value) || typeof value.enabled !== 'boolean') throw new Error('Plan details are temporarily unavailable.');
  if (!value.enabled || value.offer === null) return { enabled: value.enabled, offer: null };
  const plan = value.offer;
  if (!object(plan) || typeof plan.version !== 'string' || typeof plan.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(plan.sha256) || plan.interval !== 'monthly' || typeof plan.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(plan.currency) || ![plan.priceMinor, plan.includedFinalizedProofs, plan.maxRecordingBytes, plan.maxRecordingSeconds].every(count)) throw new Error('The current offer could not be verified. Refresh and try again.');
  return value as BillingOffer;
}
export function readInvoices(value: unknown): InvoicePage {
  if (!object(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.invoices) || value.invoices.length > 100) throw new Error('Invoices are temporarily unavailable.');
  if (!value.enabled) return { enabled: false, invoices: [] };
  if (!['sandbox','live'].includes(String(value.environment)) || typeof value.hasMore !== 'boolean' || (value.hasMore && typeof value.nextStartingAfter !== 'string')) throw new Error('The invoice page is unavailable.');
  for (const row of value.invoices) if (!object(row) || typeof row.invoiceReference !== 'string' || !/^in_[A-Za-z0-9]{1,180}$/.test(row.invoiceReference) || !['draft','open','paid','uncollectible','void','unknown'].includes(String(row.status)) || row.currency !== 'USD' || ![row.amountDueMinor, row.amountPaidMinor].every(count) || !date(row.createdAt)) throw new Error('An invoice could not be verified.');
  return value as InvoicePage;
}
export function readUsage(value: unknown): Usage {
  if (!object(value) || !object(value.window) || !date(value.window.start) || !date(value.window.end) || typeof value.message !== 'string' || ![value.finalizedWithDurabilityReceipt, value.finalizedWithoutConfirmedDurability, value.recordedUsageUnits].every(count)) throw new Error('Proof usage is temporarily unavailable.');
  const offer = value.currentOffer;
  if (offer !== null && (!object(offer) || typeof offer.version !== 'string' || ![offer.remaining, offer.includedFinalizedProofs].every(count) || !object(offer.period) || !date(offer.period.end))) throw new Error('Your remaining allowance is unavailable.');
  return value as Usage;
}
export function safeBillingDestination(value: string, host: 'checkout.stripe.com' | 'billing.stripe.com'): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) throw new Error('The secure billing page could not be verified. Please retry.');
  return url.href;
}
/** Re-evaluate the actual device storefront at the moment of each external billing action. */
export async function requireExternalCheckout(allowed: () => Promise<boolean>): Promise<void> {
  if (!await allowed().catch(() => false)) throw new Error('External plan management is unavailable on this device. Your existing Proofs remain available.');
}
