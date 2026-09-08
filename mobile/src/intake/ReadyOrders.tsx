import { ResolveOrder } from "./ResolveOrder";
import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from '../ui/Button';
import { ApiError } from '../v2-api';
import { IntakeApi } from './api';
import { canPollHandoffs, handoffPollDelay, intakeItemLabel, mergeHandoffs, type IntakeCapabilities, type IntakeDeviceCredentials, type IntakeHandoff, type IntakeOrder, type IntakeSnapshot } from './model';
import { readIntakeDevice } from './storage';

/** This component only prepares cards. An explicit Record action is the sole camera entry. */
export function ReadyOrders({ onPreparedProofsChange }: { onPreparedProofsChange: (ids: string[]) => void }) {
  const app = usePackProof();
  const { colors } = useTheme();
  const [capabilities, setCapabilities] = useState<IntakeCapabilities | null>(null);
  const [orders, setOrders] = useState<IntakeOrder[]>([]);
  const [handoffs, setHandoffs] = useState<IntakeHandoff[]>([]);
  const [device, setDevice] = useState<IntakeDeviceCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const activity = useRef(Date.now());
  const inFlight = useRef(false);
  const userId = app.session?.userId;
  const captureBusy = app.busy || ['capturing', 'preparing', 'uploading'].includes(app.captureStatus) || Boolean(app.localCapture && !['FINALIZED', 'SUBMITTED'].includes(app.localCapture.recovery?.phase ?? ''));
  const current = useRef({ busy: captureBusy, foreground, userId });
  current.current = { busy: captureBusy, foreground, userId };

  useEffect(() => { const listener = AppState.addEventListener('change', state => { setForeground(state === 'active'); if (state === 'active') activity.current = Date.now(); }); return () => listener.remove(); }, []);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const api = new IntakeApi(app.client);
    void app.ensureAuth().then(async () => {
      const flags = await api.capabilities();
      const [prepared, pairing] = await Promise.all([api.orders(), readIntakeDevice(app.client, userId)]);
      if (!alive || current.current.userId !== userId) return;
      setCapabilities(flags); setOrders(prepared.orders); setDevice(pairing); setError(null);
    }).catch(reason => { if (alive && !(reason instanceof ApiError && [404, 503].includes(reason.status))) setError('Prepared orders could not be refreshed. Your existing Proofs are still available.'); });
    return () => { alive = false; };
  }, [userId, app.client, refresh]);

  useEffect(() => {
    if (!userId || !device || !capabilities?.handoffEnabled || !foreground || captureBusy) return;
    let alive = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = new IntakeApi(app.client);
    const tick = async () => {
      if (!alive) return;
      if (!canPollHandoffs({ foreground: current.current.foreground, readyScreen: alive, busy: current.current.busy, paired: true, lastActivityAt: activity.current, now: Date.now() })) { setPaused(true); return; }
      if (inFlight.current) { timer = setTimeout(() => void tick(), 2_000); return; }
      inFlight.current = true;
      try {
        await app.ensureAuth();
        if (!alive || current.current.busy || !current.current.foreground) return;
        const result = await api.pending(device);
        if (!alive || current.current.userId !== userId) return;
        const recovering = result.activeCapture?.session.state === 'ISSUED' ? [result.activeCapture.handoff] : [];
        setHandoffs(previous => mergeHandoffs(previous, [...recovering, ...result.handoffs], Date.now()));
        setError(null); failures = 0;
      } catch (reason) {
        if (!alive) return;
        failures += 1;
        if (reason instanceof ApiError && [401, 403, 404, 410].includes(reason.status)) { setError('Reconnect this recording phone in Account → Connections.'); return; }
        setError('The phone is waiting to reconnect. Prepared orders stay available.');
      } finally { inFlight.current = false; }
      if (alive) timer = setTimeout(() => void tick(), handoffPollDelay(failures));
    };
    setPaused(false); void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [userId, app.client, device?.deviceId, capabilities?.handoffEnabled, foreground, captureBusy, refresh]);

  const unavailableProofIds = new Set(app.proofCollection.filter(row => row.status !== 'READY_FOR_EVIDENCE').map(row => row.proofId));
  const displayedHandoffs = handoffs.filter(row => !unavailableProofIds.has(row.orderSnapshot.proofId));
  const queuedSnapshotIds = new Set(handoffs.map(row => row.orderSnapshot.id));
  const ready = orders.filter(row => row.readiness === 'READY' && row.snapshot && !unavailableProofIds.has(row.snapshot.proofId) && !queuedSnapshotIds.has(row.snapshot.id));
  const preparedIds = [...displayedHandoffs.map(row => row.orderSnapshot.proofId), ...ready.map(row => row.snapshot!.proofId)];
  const preparedKey = preparedIds.join('|');
  useEffect(() => { onPreparedProofsChange(preparedIds); return () => onPreparedProofsChange([]); }, [preparedKey, onPreparedProofsChange]);
  if (!capabilities) return null;
  const attention = orders.filter(row => ['NEEDS_INFORMATION', 'QUARANTINED'].includes(row.readiness));
  if (!handoffs.length && !ready.length && !attention.length && !device && !error) return null;
  function touch() { activity.current = Date.now(); if (paused) { setPaused(false); setRefresh(value => value + 1); } }
  function card(snapshot: IntakeSnapshot, handoffId?: string) { return <View key={handoffId ?? snapshot.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>{snapshot.store} · {snapshot.orderReference ? `Order ${snapshot.orderReference}` : 'Prepared order'}</Text>
    {snapshot.items.map((item, index) => <Text key={index} style={[styles.copy, { color: colors.textPrimary }]}>{intakeItemLabel(item)}</Text>)}
    <Text style={[styles.copy, { color: colors.textSecondary }]}>Ready to record · {snapshot.sourceKind === 'FORWARDED_EMAIL' ? 'Forwarded order email' : snapshot.sourceKind === 'BROWSER_CAPTURED' ? 'Selected on your computer' : 'Connected store'}</Text>
    <Button label="Record" icon="videocam-outline" disabled={captureBusy} onPress={() => { touch(); void app.startIntakeCapture({ snapshotId: snapshot.id, handoffId }); }} />
  </View>; }
  return <View onTouchStart={touch} style={styles.section}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>Ready to record</Text>
    {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>{error}</Text> : null}
    {paused ? <Button label="Check for orders" variant="tertiary" onPress={touch} /> : null}
    {captureBusy && handoffs.length ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Your next order is waiting. Finish the current recording first.</Text> : null}
    {displayedHandoffs.map(row => card(row.orderSnapshot, row.id))}
    {ready.map(row => card(row.snapshot!))}
    {attention.map(order => <ResolveOrder key={order.observationId} order={order} disabled={captureBusy} onResolved={result => { setOrders(previous => previous.map(row => row.observationId === order.observationId ? result : row)); }} />)}
    {!handoffs.length && !ready.length && device && !error ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Waiting for an order from your computer.</Text> : null}
    <Button label="Refresh prepared orders" variant="tertiary" disabled={captureBusy} onPress={() => { touch(); setRefresh(value => value + 1); }} />
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 12 }, card: { padding: 16, borderWidth: 1, borderRadius: 8, gap: 8 }, title: { ...typography.bodyStrong }, copy: { ...typography.secondary } });
