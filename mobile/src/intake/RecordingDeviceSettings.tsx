import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { ErrorBanner } from '../ui/EmptyState';
import { IntakeApi } from './api';
import type { IntakeDevice } from './model';
import { readHandoffTarget, saveHandoffTarget } from './storage';

export function RecordingDeviceSettings({ localDeviceId }: { localDeviceId?: string }) {
  const app = usePackProof(), { colors } = useTheme(), userId = app.session!.userId;
  const api = new IntakeApi(app.client);
  const [devices, setDevices] = useState<IntakeDevice[]>([]), [selectedId, setSelectedId] = useState(''), [targetId, setTargetId] = useState<string | null>(null);
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const active = useRef(true), locked = useRef(false);
  const selected = devices.find(row => row.id === selectedId), approved = selected?.state === 'APPROVED';
  const body = [typography.body, { color: colors.textPrimary }], secondary = [typography.secondary, { color: colors.textSecondary }];
  function assertAccount() { if (!active.current) throw new Error('Reopen Connections to continue.'); app.client.assertCaptureAccount(userId, app.apiBaseUrl); }
  async function refresh() {
    const [result, saved] = await Promise.all([api.devices(), readHandoffTarget(app.client, userId)]); assertAccount();
    const available = result.devices.filter(row => row.state !== 'REVOKED' && row.id !== localDeviceId);
    setDevices(available); setTargetId(saved && available.some(row => row.id === saved && row.state === 'APPROVED') ? saved : null);
    setSelectedId(previous => available.some(row => row.id === previous) ? previous : available.find(row => row.id === saved)?.id ?? '');
  }
  async function run(work: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(null); setNotice('');
    try { await app.ensureAuth(); assertAccount(); await work(); }
    catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : 'Recording devices could not be updated. Try again.'); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => { active.current = true; void run(refresh); return () => { active.current = false; }; }, [app.client, userId, localDeviceId]);
  async function disconnect() {
    if (!selected) return;
    const id = selected.id;
    await api.revoke(id); assertAccount();
    if (id === targetId) await saveHandoffTarget(app.client, userId, null);
    assertAccount(); setSelectedId(''); setCode(''); await refresh(); setNotice('Recording device disconnected. Existing recordings remain available.');
  }
  return <View style={{ gap: 12 }}>
    <Text style={secondary}>On the other device, open Connections and choose “Pair this recording phone.” Select it below and enter its pairing code.</Text>
    {!devices.length && !busy ? <Text style={secondary}>No other recording devices are waiting or paired.</Text> : null}
    <View accessibilityRole="radiogroup" accessibilityLabel="Recording device">
      {devices.map(device => <Pressable key={device.id} accessibilityRole="radio" accessibilityLabel={device.name} accessibilityState={{ checked: selectedId === device.id, disabled: busy }} disabled={busy} onPress={() => { setSelectedId(device.id); setCode(''); setNotice(''); }} style={{ paddingVertical: 12 }}>
        <Text style={body}>{selectedId === device.id ? '◉' : '○'} {device.name}{targetId === device.id ? ' · Default' : ''}</Text>
        <Text style={secondary}>{device.state === 'APPROVED' ? device.online ? 'Paired · Ready to receive' : 'Paired · Open PackProof on this device to receive orders' : 'Waiting for approval'}</Text>
      </Pressable>)}
    </View>
    {selected && !approved ? <>
      <FormField label="Pairing code shown on the other device" value={code} onChangeText={value => setCode(value.toUpperCase().slice(0, 12))} autoCapitalize="characters" editable={!busy} />
      <Button label="Approve recording device" disabled={busy || !/^[A-F0-9]{12}$/.test(code.trim())} onPress={() => void run(async () => {
        const result = await api.approve(selected.id, code.trim()); assertAccount();
        if (result.device.id !== selected.id || result.device.state !== 'APPROVED') throw new Error('Approval was not confirmed. Refresh and check the pairing code.');
        setCode(''); await refresh(); setNotice('Device approved. You can now use it as your default recording device.');
      })} />
    </> : null}
    {approved && selectedId !== targetId ? <Button label="Use as default recording device" disabled={busy} variant="secondary" onPress={() => void run(async () => { await saveHandoffTarget(app.client, userId, selectedId); assertAccount(); setTargetId(selectedId); setNotice('Default recording device saved for this account.'); })} /> : null}
    {targetId ? <Button label="Clear default recording device" disabled={busy} variant="tertiary" onPress={() => void run(async () => { await saveHandoffTarget(app.client, userId, null); assertAccount(); setTargetId(null); })} /> : null}
    {selected ? <Button label="Disconnect selected device" disabled={busy} variant="tertiary" onPress={() => Alert.alert('Disconnect recording device?', `New orders will no longer be sent to ${selected.name}. Existing recordings remain available.`, [{ text: 'Keep device', style: 'cancel' }, { text: 'Disconnect', style: 'destructive', onPress: () => void run(disconnect) }])} /> : null}
    <Button label="Refresh recording devices" variant="tertiary" loading={busy} onPress={() => void run(refresh)} />
    <ErrorBanner message={error} />
    {notice ? <Text accessibilityLiveRegion="polite" style={secondary}>{notice}</Text> : null}
  </View>;
}
