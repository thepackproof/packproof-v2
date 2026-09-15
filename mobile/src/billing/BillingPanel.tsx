import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, Text, View } from 'react-native';
import { getExternalCheckoutAllowed } from '../../modules/packproof-storefront';
import { usePackProof } from '../app/PackProofProvider';
import { newIdempotencyKey } from '../v2-api';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { TERMS_OF_SERVICE_URL } from '../copy/legal';
import { InfoCard } from '../ui/ProofCard';
import { Button } from '../ui/Button';
import { SectionHeader } from '../ui/AppHeader';
import { ErrorBanner } from '../ui/EmptyState';
import { readBillingStatus, readBillingOffer, readInvoices, readUsage, requireExternalCheckout, safeBillingDestination, type BillingStatus, type BillingOffer, type InvoicePage, type Usage } from './model';

const displayDate = (value: string | null) => value ? new Date(value).toLocaleDateString() : 'Not yet available';
const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);
const statuses: Record<string, string> = { active: 'Active', trialing: 'Trial', past_due: 'Payment needs attention', unpaid: 'Unpaid', canceled: 'Canceled', incomplete: 'Checkout incomplete', incomplete_expired: 'Checkout expired', paused: 'Paused' };

export function BillingPanel() {
  const app = usePackProof(), { colors } = useTheme(), userId = app.session!.userId;
  const [status, setStatus] = useState<BillingStatus | null>(null), [offer, setOffer] = useState<BillingOffer | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null), [invoices, setInvoices] = useState<InvoicePage | null>(null);
  const [externalAllowed, setExternalAllowed] = useState(false), [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null), [invoiceError, setInvoiceError] = useState<string | null>(null);
  const mounted = useRef(true), locked = useRef(false), operation = useRef<string | null>(null);
  const body = [typography.body, { color: colors.textPrimary }], secondary = [typography.secondary, { color: colors.textSecondary }];
  function assertAccount() { if (!mounted.current) throw new Error('Open your account to continue.'); app.client.assertCaptureAccount(userId, app.apiBaseUrl); }
  async function refresh() {
    await app.ensureAuth(); assertAccount();
    const [billing, usageResult, invoiceResult, allowed] = await Promise.allSettled([
      app.client.billingRequest<unknown>('status').then(readBillingStatus),
      app.client.getUsage<unknown>().then(readUsage),
      app.client.getBillingInvoices<unknown>().then(readInvoices),
      getExternalCheckoutAllowed(),
    ]);
    assertAccount(); setExternalAllowed(allowed.status === 'fulfilled' && allowed.value);
    if (usageResult.status === 'fulfilled') { setUsage(usageResult.value); setUsageError(null); } else setUsageError('Proof usage is temporarily unavailable.');
    if (invoiceResult.status === 'fulfilled') { setInvoices(invoiceResult.value); setInvoiceError(null); } else setInvoiceError('Invoices are temporarily unavailable.');
    if (billing.status === 'rejected') throw new Error('Your plan could not load. Refresh to try again.');
    setStatus(billing.value);
    if (billing.value.enabled) { const next = readBillingOffer(await app.client.billingRequest<unknown>('offer')); assertAccount(); setOffer(next); }
    else setOffer(null);
  }
  async function run(action: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(null); setNotice('');
    try { await action(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Billing could not load. Please try again.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; void run(refresh);
    const wake = AppState.addEventListener('change', state => { if (state === 'active') void run(refresh); });
    return () => { mounted.current = false; wake.remove(); };
  }, [app.client, userId]);
  useEffect(() => { setAccepted(false); operation.current = null; }, [offer?.offer?.sha256]);
  const plan = offer?.enabled ? offer.offer : null;
  const active = status?.subscriptions.some(row => ['active','trialing','past_due','unpaid','incomplete'].includes(row.status));
  async function openCheckout(operationId: string) {
    if (!plan) throw new Error('Refresh the current offer before opening checkout.');
    await requireExternalCheckout(getExternalCheckoutAllowed); await app.ensureAuth(); assertAccount();
    const result = await app.client.billingRequest<{ url: string | null }>('checkout', { operationId, offerVersion: plan.version, acceptedOfferSha256: plan.sha256 });
    assertAccount();
    if (result.url) { await requireExternalCheckout(getExternalCheckoutAllowed); await Linking.openURL(safeBillingDestination(result.url, 'checkout.stripe.com')); }
    else await refresh();
  }
  return <View style={{ gap: 16 }}>
    <ErrorBanner message={error} />
    {notice ? <Text accessibilityLiveRegion="polite" style={body}>{notice}</Text> : null}
    {status?.environment === 'sandbox' ? <Text style={secondary}>Test billing. These subscription details are not live charges.</Text> : null}
    {!status && busy ? <Text style={secondary}>Loading your plan…</Text> : null}
    {status?.subscriptions.map(subscription => <InfoCard key={subscription.subscriptionReference}>
      <Text style={[typography.sectionTitle, { color: colors.textPrimary }]}>{statuses[subscription.status] ?? 'Status needs review'}</Text>
      {subscription.trialEnd && subscription.status === 'trialing' ? <Text style={body}>Trial ends {displayDate(subscription.trialEnd)}.</Text> : null}
      {subscription.cancelAtPeriodEnd || subscription.cancelAt ? <Text style={body}>Cancellation scheduled for {displayDate(subscription.cancelAt || subscription.currentPeriodEnd)}.</Text> : null}
      {subscription.status === 'canceled' ? <Text style={body}>Subscription ended {displayDate(subscription.endedAt || subscription.canceledAt)}.</Text> : null}
      {subscription.nextCharge ? <Text style={body}>Next expected base charge: {subscription.nextCharge.baseAmountMinor !== null && subscription.nextCharge.currency ? money(subscription.nextCharge.baseAmountMinor, subscription.nextCharge.currency) : 'Amount not yet available'} · {displayDate(subscription.nextCharge.expectedAt)}. Taxes and adjustments may change the final invoice.</Text> : null}
      {externalAllowed && ['active','trialing','past_due'].includes(subscription.status) && !subscription.cancelAtPeriodEnd && !subscription.cancelAt ? <Button label="Review cancellation" variant="secondary" disabled={busy} onPress={() => void run(async () => {
        await requireExternalCheckout(getExternalCheckoutAllowed); await app.ensureAuth(); assertAccount();
        const result = await app.client.billingRequest<{ url: string }>('cancellation-portal', { subscriptionReference: subscription.subscriptionReference, operationId: newIdempotencyKey() });
        assertAccount(); await requireExternalCheckout(getExternalCheckoutAllowed); await Linking.openURL(safeBillingDestination(result.url, 'billing.stripe.com'));
      })} /> : null}
    </InfoCard>)}
    {status?.enabled && status.pendingCheckout ? <InfoCard><Text style={body}>A checkout is awaiting confirmation.</Text>
      <Button label="Check checkout status" variant="secondary" disabled={busy} onPress={() => void run(async () => {
        await app.ensureAuth(); assertAccount(); const result = await app.client.billingRequest<{ state: string; enrolled: boolean }>('checkout/complete', { operationId: status.pendingCheckout });
        assertAccount(); await refresh(); setNotice(result.enrolled ? 'Your plan is active.' : result.state === 'EXPIRED' ? 'Checkout expired. You can start again.' : 'Checkout is not complete yet. No enrollment has been confirmed.');
      })} />
      {externalAllowed && plan ? <Button label="Return to secure checkout" variant="secondary" disabled={busy} onPress={() => void run(() => openCheckout(status.pendingCheckout!))} /> : null}
    </InfoCard> : null}
    {externalAllowed && status?.enabled && !active && !status.pendingCheckout && plan ? <InfoCard>
      <Text style={[typography.sectionTitle, { color: colors.textPrimary }]}>{money(plan.priceMinor, plan.currency)} per month</Text>
      <Text style={body}>{plan.includedFinalizedProofs} Proofs included. Recordings up to {Math.floor(plan.maxRecordingSeconds / 60)} minutes and {(plan.maxRecordingBytes / 1_000_000).toFixed(0)} MB.</Text>
      <Text style={secondary}>New captures pause when your allowance is used. Existing evidence stays accessible under its retention policy.</Text>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: accepted, disabled: busy }} disabled={busy} onPress={() => setAccepted(!accepted)} style={{ paddingVertical: 12 }}><Text style={body}>{accepted ? '☑' : '☐'} I accept this recurring monthly offer and the Terms of Service.</Text></Pressable>
      <Button label="Terms of Service" variant="tertiary" onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL)} />
      <Button label="Continue to secure checkout" disabled={busy || !accepted} loading={busy} onPress={() => void run(async () => { operation.current ??= newIdempotencyKey(); await openCheckout(operation.current); })} />
    </InfoCard> : null}
    {status?.enabled === false ? <Text style={secondary}>Paid plans are not enabled for this account.</Text> : null}
    <SectionHeader title="Proof usage" />
    <ErrorBanner message={usageError} />
    {usage ? <InfoCard><Text style={body}>{usage.message}</Text>
      <Text style={body}>Preserved finalized Proofs this month: {usage.finalizedWithDurabilityReceipt}</Text>
      <Text style={body}>Finalized records awaiting preservation: {usage.finalizedWithoutConfirmedDurability}</Text>
      <Text style={body}>Recorded usage units: {usage.recordedUsageUnits}</Text>
      {usage.currentOffer ? <Text style={body}>{usage.currentOffer.remaining} of {usage.currentOffer.includedFinalizedProofs} included Proofs remain through {displayDate(usage.currentOffer.period.end)}.</Text> : null}
      <Text style={secondary}>Your new-capture allowance does not change access to existing Proofs or their preservation.</Text>
    </InfoCard> : null}
    {invoices?.enabled || invoiceError ? <SectionHeader title="Billing invoices" /> : null}
    <ErrorBanner message={invoiceError} />
    {invoices?.enabled && !invoices.invoices.length ? <Text style={secondary}>No invoices are available for this billing account.</Text> : null}
    {invoices?.environment === 'sandbox' ? <Text style={secondary}>These invoices are test billing records.</Text> : null}
    {invoices?.invoices.map(invoice => <InfoCard key={invoice.invoiceReference}>
      <Text selectable style={body}>{invoice.invoiceReference}</Text><Text style={secondary}>{displayDate(invoice.createdAt)} · {invoice.status}</Text>
      <Text style={body}>Invoice amount due: {money(invoice.amountDueMinor, invoice.currency)}</Text><Text style={body}>Paid: {money(invoice.amountPaidMinor, invoice.currency)}</Text>
    </InfoCard>)}
    {invoices?.hasMore ? <Button label="Load older invoices" variant="secondary" disabled={busy} onPress={() => void run(async () => {
      await app.ensureAuth(); assertAccount(); const next = readInvoices(await app.client.getBillingInvoices<unknown>(invoices.nextStartingAfter ?? undefined)); assertAccount();
      setInvoices(previous => ({ ...next, invoices: [...new Map([...(previous?.invoices ?? []), ...next.invoices].map(row => [row.invoiceReference, row])).values()] }));
    })} /> : null}
    <Button label="Refresh plan and usage" variant="secondary" disabled={busy} loading={busy} onPress={() => void run(refresh)} />
  </View>;
}
