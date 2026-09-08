import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { FormField } from '../ui/FormField';
import { Button } from '../ui/Button';
import { newIdempotencyKey } from '../v2-api';
import { IntakeApi } from './api';
import type { IntakeOrder } from './model';
import { buildIntakeResolution, intakeReasonText, resolutionDraft, type FulfillmentScope, type ResolutionDraft } from './resolution';

export function ResolveOrder({ order, disabled, onResolved }: { order: IntakeOrder; disabled: boolean; onResolved: (result: IntakeOrder) => void }) {
  const app = usePackProof(); const { colors } = useTheme();
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<ResolutionDraft | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true); const lock = useRef(false);
  const receipt = useRef<{ payload: string; key: string } | null>(null);
  const account = app.session?.userId; const owner = useRef(account); owner.current = account;
  useEffect(() => () => { alive.current = false; }, []);
  async function load() {
    if (lock.current || disabled) return; lock.current = true; setBusy(true); setError(null);
    try { await app.ensureAuth(); const detail = await new IntakeApi(app.client).observation(order.observationId); if (!alive.current || owner.current !== account) return; setDraft(resolutionDraft(detail)); setReference(detail.orderReference); setOpened(true); }
    catch (reason) { if (alive.current && owner.current === account) setError(reason instanceof Error ? reason.message : 'Could not load this order. Try again.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!draft || lock.current || disabled) return; lock.current = true; setBusy(true); setError(null);
    try {
      const validated = buildIntakeResolution(draft, 'pending'); const payload = JSON.stringify(validated);
      if (receipt.current?.payload !== payload) receipt.current = { payload, key: newIdempotencyKey() };
      await app.ensureAuth(); if (owner.current !== account) return;
      const result = await new IntakeApi(app.client).resolveObservation(order.observationId, { ...validated, receiptId: receipt.current.key });
      if (!alive.current || owner.current !== account) return;
      onResolved(result); if (result.readiness === 'READY') { setOpened(false); setDraft(null); } else setError('The correction was retained. This order still needs the checks shown above before recording.');
    } catch (reason) { if (alive.current && owner.current === account) setError(reason instanceof Error ? reason.message : 'Could not save the correction. Your entries are kept here.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const blockedIdentity = order.readiness === 'QUARANTINED' || order.reasons.some(code => ['EXACT_ORDER_ID_REQUIRED', 'ORDER_SCOPE_CONFLICT', 'ORDER_CANCELLED'].includes(code));
  const editable = !disabled && !busy;
  function choose(field: 'physicalFulfillment' | 'paid', value: ResolutionDraft['paid']) { setDraft(previous => previous ? { ...previous, [field]: value } : previous); }
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>{reference ? `Order ${reference}` : 'Order needs information'}</Text>
    {order.reasons.map(code => <Text key={code} style={[styles.copy, { color: colors.textSecondary }]}>{intakeReasonText(code)}</Text>)}
    {!opened && !blockedIdentity ? <Button label="Resolve order details" variant="secondary" loading={busy} disabled={disabled} onPress={() => void load()} /> : null}
    {blockedIdentity ? <Button label="Open Connections" variant="tertiary" onPress={() => app.go('account', { accountSection: 'channels' })} /> : null}
    {opened && draft ? <>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>Use the original order to supply missing facts. Your correction is retained with the original source. Recording already started on an order cannot be rebound here.</Text>
      {draft.items.map((item, index) => <View key={index} style={styles.fields}>
        <FormField label={`Item ${index + 1} description`} value={item.title} editable={editable} onChangeText={value => setDraft(previous => previous && { ...previous, items: previous.items.map((row, i) => i === index ? { ...row, title: value } : row) })} />
        <FormField label={`Item ${index + 1} purchased quantity`} value={item.quantity} keyboardType="number-pad" editable={editable} onChangeText={value => setDraft(previous => previous && { ...previous, items: previous.items.map((row, i) => i === index ? { ...row, quantity: value } : row) })} />
        <FormField label={`Item ${index + 1} variant, if specified`} value={item.variant} editable={editable} onChangeText={value => setDraft(previous => previous && { ...previous, items: previous.items.map((row, i) => i === index ? { ...row, variant: value } : row) })} />
        <Button label={`Remove item ${index + 1}`} variant="tertiary" disabled={!editable} onPress={() => setDraft(previous => previous && { ...previous, items: previous.items.filter((_, i) => i !== index) })} />
      </View>)}
      <Button label="Add purchased item" variant="tertiary" disabled={!editable} onPress={() => setDraft(previous => previous && { ...previous, items: [...previous.items, { title: '', quantity: '', variant: '' }] })} />
      {(['physicalFulfillment', 'paid'] as const).map(field => <View key={field} style={styles.fields}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{field === 'paid' ? 'Has this order been paid?' : 'Does this order contain physical goods to ship?'}</Text>
        <View style={styles.options}>{(['yes', 'no', 'unknown'] as const).map(value => <Button key={value} label={`${draft[field] === value ? '✓ ' : ''}${value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Not known'}`} variant="tertiary" disabled={!editable} onPress={() => choose(field, value)} />)}</View>
      </View>)}
      <Text style={[styles.title, { color: colors.textPrimary }]}>What does this package contain?</Text>
      {([['UNKNOWN', 'Not known'], ['FULL_ORDER', 'The full order in one package'], ['PARTIAL', 'Part of the order'], ['MULTI_PARCEL', 'The order uses multiple packages']] as Array<[FulfillmentScope, string]>).map(([value, label]) => <Button key={value} label={`${draft.fulfillmentScope === value ? '✓ ' : ''}${label}`} variant="tertiary" disabled={!editable} onPress={() => setDraft(previous => previous && { ...previous, fulfillmentScope: value })} />)}
      <FormField label="Reason for the correction" value={draft.reason} multiline editable={editable} onChangeText={reason => setDraft(previous => previous && { ...previous, reason })} />
      <Button label="Save correction" loading={busy} disabled={disabled} onPress={() => void save()} />
      <Button label="Close details" variant="tertiary" disabled={busy} onPress={() => setOpened(false)} />
    </> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>{error}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, borderWidth: 1, borderRadius: 8, gap: 12 }, fields: { gap: 8 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, title: { ...typography.bodyStrong }, copy: { ...typography.secondary } });
