import { useState } from 'react';
import { Alert, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { AppScreen } from '../ui/AppScreen';
import { AppHeader } from '../ui/AppHeader';
import { FormField } from '../ui/FormField';
import { Button } from '../ui/Button';
import { SubmissionCard } from './SubmissionCard';
import { intakeLocalError } from './submissions';
import type { SharedOrderCoordinator } from './use-shared-order';
export function SharedOrderScreen({ coordinator }: { coordinator: SharedOrderCoordinator }) {
  const app = usePackProof(), { colors } = useTheme();
  const [text, setText] = useState(''), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const local = coordinator.sharedOrder;
  const busy = saving || coordinator.busy || app.busy;
  const leave = async () => { await coordinator.defer(); app.go('home'); };
  const copy = { ...typography.body, color: colors.textSecondary };
  async function save() {
    setSaving(true); setError(null);
    try { await coordinator.paste(text); setText(''); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the order on this device. Try again.'); }
    finally { setSaving(false); }
  }
  return <AppScreen>
    <AppHeader title={local ? 'Shared order' : 'Paste order details'} onBack={() => { void leave().catch(() => setError('Could not save your place. Try again.')); }} />
    {local ? <>
      {local.errorCode ? <Text style={copy}>{intakeLocalError(local.errorCode)}</Text> : local.accountId === null ? <>
        <Text style={copy}>Saved on this device. Choose the account that will receive this order.</Text>
        <Text style={{ ...typography.bodyStrong, color: colors.textPrimary }}>{app.session?.email ?? app.session?.displayName ?? 'Your current PackProof account'}</Text>
        <Button label="Add to this account" loading={busy} onPress={() => void coordinator.assign()} />
        <Button label="Switch account" variant="tertiary" disabled={busy} onPress={() => app.go('account')} />
      </> : coordinator.submission ? <SubmissionCard submission={coordinator.submission} disabled={busy} onChange={coordinator.setSubmission} onLeave={coordinator.defer} /> : <>
        <Text style={copy}>{local.deliveryState === 'SERVER_ACCEPTED' ? 'Added to PackProof. Reconnect to check which order was matched.' : intakeLocalError(local.errorCode)}</Text>
        {local.text ? <Text numberOfLines={5} style={copy}>{local.text.slice(0, 600)}</Text> : null}
        {!local.errorCode ? <Button label="Try again" variant="secondary" disabled={busy} onPress={coordinator.refresh} /> : null}
      </>}
      <Button label="Save for later" variant="secondary" disabled={busy} onPress={() => { void leave().catch(() => setError('Could not save your place. Try again.')); }} />
      <Button label="Discard shared order" variant="tertiary" disabled={busy} onPress={() => Alert.alert('Discard shared order?', 'This removes the shared input. Existing Proofs and recordings remain available.', [
        { text: 'Keep order', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { void coordinator.discard().then(() => app.go('home')).catch(() => setError('Could not discard this shared order. Try again.')); } },
      ])} />
    </> : <>
      <Text style={copy}>Paste an order link or the order details. PackProof will check your connected stores and ask you to choose if more than one order matches.</Text>
      <Button label="Paste order details" variant="secondary" disabled={busy} onPress={() => { void Clipboard.getStringAsync().then(value => { if (value.length > 20000) { setError('Paste up to 20,000 characters.'); return; } setText(value); setError(null); }).catch(() => setError('Could not read the clipboard. Paste directly into the field.')); }} />
      <FormField label="Order text or link" value={text} onChangeText={setText} multiline editable={!busy} />
      <Button label="Add to PackProof" disabled={!text.trim() || text.length > 20000} loading={busy} onPress={() => void save()} />
      <Button label="Enter order details myself" variant="tertiary" disabled={busy} onPress={() => app.go('manual')} />
    </>}
    {error || coordinator.error ? <Text accessibilityRole="alert" style={copy}>{error ?? coordinator.error}</Text> : null}
  </AppScreen>;
}
