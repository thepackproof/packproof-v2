import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { FormField } from '../ui/FormField';
import { Button } from '../ui/Button';
import { IntakeApi } from './api';
import type { IntakeSubmission } from './submissions';
import { confirmedSubmissionDetails, type SubmissionDraft } from './submissions';
const empty: SubmissionDraft = { itemTitle: '', quantity: '', externalReference: '', physicalFulfillment: null, paid: null, fulfillmentScope: 'UNKNOWN' };

/** The draft and server operation retain one original submission identity through restarts. */
export function SubmissionDetails({ submission, disabled, onResolved }: { submission: IntakeSubmission; disabled: boolean; onResolved: (value: IntakeSubmission) => void }) {
  const app = usePackProof(), { colors } = useTheme(), account = app.session?.userId;
  const key = `packproof.intake-draft:v1:${encodeURIComponent(app.apiBaseUrl)}:${encodeURIComponent(account ?? '')}:${submission.submissionId}`;
  const [draft, setDraft] = useState<SubmissionDraft>(empty), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false), current = useRef(key); current.current = key;
  useEffect(() => { let alive = true; setReady(false); void AsyncStorage.getItem(key).then(raw => { if (!alive) return; try { setDraft(raw ? { ...empty, ...JSON.parse(raw) } : empty); } catch { setDraft(empty); } setReady(true); }); return () => { alive = false; }; }, [key]);
  useEffect(() => { if (!ready || busy) return; const timer = setTimeout(() => { void AsyncStorage.setItem(key, JSON.stringify(draft)).catch(() => setError('This draft could not be saved on the device. Keep this screen open and try again.')); }, 250); return () => clearTimeout(timer); }, [key, ready, draft, busy]);
  const editable = ready && !busy && !disabled;
  async function save() {
    if (!editable || lock.current || !account) return; lock.current = true; setBusy(true); setError(null);
    try {
      const input = confirmedSubmissionDetails(draft);
      await AsyncStorage.setItem(key, JSON.stringify(draft));
      await app.ensureAuth(); app.client.assertCaptureAccount(account, app.apiBaseUrl);
      const result = await new IntakeApi(app.client).resolveSubmission(submission.submissionId, input);
      if (current.current !== key) return;
      await AsyncStorage.removeItem(key); onResolved(result);
    } catch (reason) { if (current.current === key) setError(reason instanceof Error ? reason.message : 'Could not save the order. Your draft remains on this device.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const copy = { ...typography.secondary, color: colors.textSecondary };
  return <View style={{ gap: 12 }}>
    <Text style={copy}>Use the original order to confirm these details. This records the order context; packing still needs a video and your attestation.</Text>
    <FormField label="Item description" value={draft.itemTitle} editable={editable} onChangeText={itemTitle => setDraft(previous => ({ ...previous, itemTitle }))} />
    <FormField label="Purchased quantity" value={draft.quantity} keyboardType="number-pad" editable={editable} onChangeText={quantity => setDraft(previous => ({ ...previous, quantity }))} />
    <FormField label="Order reference, if available" value={draft.externalReference} editable={editable} onChangeText={externalReference => setDraft(previous => ({ ...previous, externalReference }))} />
    {(['physicalFulfillment', 'paid'] as const).map(field => <View key={field} style={{ gap: 6 }}>
      <Text style={copy}>{field === 'paid' ? 'Has this order been paid for?' : 'Does this order contain physical items to ship?'}</Text>
      {([true, false] as const).map(value => <Button key={String(value)} label={`${draft[field] === value ? '✓ ' : ''}${value ? 'Yes' : 'No'}`} variant="secondary" disabled={!editable} onPress={() => setDraft(previous => ({ ...previous, [field]: value }))} />)}
    </View>)}
    <Text style={copy}>What will this recording cover?</Text>
    {([{ value: 'FULL_ORDER', label: 'The entire order in one package' }, { value: 'PARTIAL', label: 'Part of the order' }, { value: 'MULTI_PARCEL', label: 'The order in multiple packages' }] as const).map(option => <Button key={option.value} label={`${draft.fulfillmentScope === option.value ? '✓ ' : ''}${option.label}`} variant="secondary" disabled={!editable} onPress={() => setDraft(previous => ({ ...previous, fulfillmentScope: option.value }))} />)}
    {error ? <Text accessibilityRole="alert" style={copy}>{error}</Text> : null}
    <Button label="Confirm order details" loading={busy} disabled={!editable} onPress={() => void save()} />
  </View>;
}
