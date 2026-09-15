import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/EmptyState';
import { InfoCard } from '../ui/ProofCard';
import { IntakeApi } from './api';
import { intakeItemLabel, type IntakeDevice, type IntakeSnapshot } from './model';
import { approvedRecordingDevices, reviewedHandoffSnapshot, sendReviewedHandoff } from './handoff-sender';
import { clearIntakeRequestKey, intakeRequestKey, readHandoffTarget, readIntakeDevice, saveHandoffTarget } from './storage';

export function SelectedOrderHandoff({ proofId, transactionId, onManageDevices }: { proofId: string; transactionId: string; onManageDevices: () => void }) {
  const app = usePackProof(), { colors } = useTheme(), userId = app.session!.userId, api = new IntakeApi(app.client);
  const [enabled, setEnabled] = useState(false), [expanded, setExpanded] = useState(false), [chooseDevice, setChooseDevice] = useState(false);
  const [devices, setDevices] = useState<IntakeDevice[]>([]), [targetId, setTargetId] = useState(''), [snapshot, setSnapshot] = useState<IntakeSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const active = useRef(true), locked = useRef(false);
  const body = [typography.body, { color: colors.textPrimary }], secondary = [typography.secondary, { color: colors.textSecondary }];
  const target = devices.find(device => device.id === targetId);
  function assertAccount() { if (!active.current) throw new Error('Reopen this Proof to send its order.'); app.client.assertCaptureAccount(userId, app.apiBaseUrl); }
  useEffect(() => {
    active.current = true;
    void app.ensureAuth().then(() => { assertAccount(); return api.capabilities(); }).then(result => { if (active.current) setEnabled(result.handoffEnabled); }).catch(() => undefined);
    return () => { active.current = false; };
  }, [app.client, userId, proofId]);
  async function run(work: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(null); setNotice('');
    try { await app.ensureAuth(); assertAccount(); await work(); }
    catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : 'This order could not be sent. Try again.'); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  }
  async function loadReview() {
    setSnapshot(null);
    const [order, listed, saved, local] = await Promise.all([api.prepare(transactionId), api.devices(), readHandoffTarget(app.client, userId), readIntakeDevice(app.client, userId)]);
    assertAccount();
    const prepared = reviewedHandoffSnapshot(order, proofId, transactionId), approved = approvedRecordingDevices(listed.devices, local?.deviceId);
    setSnapshot(prepared); setDevices(approved);
    const selected = approved.find(device => device.id === saved);
    setTargetId(selected?.id ?? ''); setChooseDevice(!selected);
  }
  if (!enabled) return null;
  return <View style={{ gap: 12 }}>
    <Button label={expanded ? 'Hide recording-device options' : 'Record on another device'} icon="phone-portrait-outline" variant="secondary" disabled={busy || app.busy} onPress={() => { if (expanded) setExpanded(false); else { setExpanded(true); void run(loadReview); } }} />
    {expanded ? <InfoCard>
      {snapshot ? <>
        <Text style={[typography.bodyStrong, { color: colors.textPrimary }]}>{snapshot.store} · {snapshot.orderReference}</Text>
        {snapshot.items.map((item, index) => <Text key={index} style={body}>{intakeItemLabel(item)}</Text>)}
        <Text style={secondary}>The selected device will receive this order for review and recording. Sending it does not start a camera or submit evidence.</Text>
      </> : busy ? <Text style={secondary}>Preparing the order for review…</Text> : null}
      {target ? <Text style={body}>Recording device: {target.name}</Text> : null}
      {chooseDevice ? <View accessibilityRole="radiogroup" accessibilityLabel="Send order to recording device">
        {devices.map(device => <Pressable key={device.id} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: targetId === device.id, disabled: busy }} accessibilityLabel={device.name} onPress={() => { setTargetId(device.id); setNotice(''); }} style={{ paddingVertical: 12 }}><Text style={body}>{targetId === device.id ? '◉' : '○'} {device.name}</Text></Pressable>)}
      </View> : <Button label="Choose another device" variant="tertiary" disabled={busy} onPress={() => setChooseDevice(true)} />}
      {!devices.length && !busy ? <Text style={secondary}>Approve another recording device in Connections to send this order.</Text> : null}
      {target ? <>
        <Button label={`Send order to ${target.name}`} disabled={busy || !snapshot || app.busy} loading={busy} onPress={() => void run(async () => {
          if (!snapshot) throw new Error('Refresh the order before sending.');
          const result = await sendReviewedHandoff({ snapshot, targetDeviceId: target.id }, {
            assertAccount,
            readKey: sourceId => intakeRequestKey(app.client, userId, sourceId),
            clearKey: sourceId => clearIntakeRequestKey(app.client, userId, sourceId),
            send: value => api.send(value),
          });
          setNotice(result.state === 'CLAIMED' ? `This order has already been accepted on ${target.name}.` : `Order sent. Open PackProof on ${target.name} to review and record it.`);
        })} />
        <Button label="Use this device by default" variant="tertiary" disabled={busy} onPress={() => void run(async () => { await saveHandoffTarget(app.client, userId, target.id); assertAccount(); setNotice('Default recording device saved for this account.'); })} />
      </> : null}
      <Button label="Manage recording devices" variant="tertiary" disabled={busy} onPress={onManageDevices} />
      <Button label="Refresh order and devices" variant="tertiary" disabled={busy} onPress={() => void run(loadReview)} />
      <ErrorBanner message={error} />
      {notice ? <Text accessibilityLiveRegion="polite" style={body}>{notice}</Text> : null}
    </InfoCard> : null}
  </View>;
}
