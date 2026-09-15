import { orderShare } from "../../modules/packproof-order-share";
import { visibleLocalOrders } from "./submissions";
import { SubmissionCard } from "./SubmissionCard";
import type { IntakeSubmission } from "./submissions";
import { loadIntakeQueueCache, saveIntakeQueueCache } from "./queue-cache";
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
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false);
  const [localPendingCount, setLocalPendingCount] = useState(0);
  const refreshedScope = useRef<string | null>(null);
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

  useEffect(() => { const listener = AppState.addEventListener('change', state => { setForeground(state === 'active'); if (state === 'active') { activity.current = Date.now(); setRefresh(value => value + 1); } }); return () => listener.remove(); }, []);
  useEffect(() => {
    if (!userId) { setOrders([]); setSubmissions([]); setHandoffs([]); setDevice(null); return; }
    let alive = true;
    setFresh(false); setOrders([]); setSubmissions([]); setHandoffs([]); setDevice(null); setCapabilities(null); setLocalPendingCount(0); refreshedScope.current = null;
    void loadIntakeQueueCache(app.apiBaseUrl, userId).then(cached => {
      if (!alive || current.current.userId !== userId || !cached || refreshedScope.current === `${app.apiBaseUrl}:${userId}`) return;
      setOrders(cached.orders); setCachedAt(cached.savedAt);
    });
    return () => { alive = false; };
  }, [userId, app.apiBaseUrl]);
  useEffect(() => {
    if (!userId || !foreground) return;
    let alive = true;
    const api = new IntakeApi(app.client);
    void orderShare?.listPending().then(rows => { if (alive && current.current.userId === userId) setLocalPendingCount(visibleLocalOrders(rows, userId).filter(row => row.deliveryState === 'LOCAL_PENDING').length); }).catch(() => undefined);
    void app.ensureAuth().then(async () => {
      app.client.assertCaptureAccount(userId, app.apiBaseUrl);
      const flags = await api.capabilities();
      const [prepared, pairing, unresolved] = await Promise.all([api.orders(), readIntakeDevice(app.client, userId), flags.submissionEnabled ? api.submissions() : Promise.resolve({ submissions: [] })]);
      if (!alive || current.current.userId !== userId) return;
      app.client.assertCaptureAccount(userId, app.apiBaseUrl);
      refreshedScope.current = `${app.apiBaseUrl}:${userId}`;
      setCapabilities(flags); setOrders(prepared.orders); setDevice(pairing); setSubmissions(unresolved.submissions); setError(null); setFresh(true); setCachedAt(Date.now());
      await saveIntakeQueueCache(app.apiBaseUrl, userId, prepared.orders);
    }).catch(reason => { if (alive && !(reason instanceof ApiError && [404, 503].includes(reason.status))) { setFresh(false); setError('Prepared orders could not be refreshed. Your saved queue remains available.'); } });
    return () => { alive = false; };
  }, [userId, app.client, refresh, foreground]);

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
  const attention = orders.filter(row => ['NEEDS_INFORMATION', 'QUARANTINED'].includes(row.readiness));
  const unresolved = submissions.filter(row => !['READY', 'DISMISSED'].includes(row.state));
  if (!handoffs.length && !ready.length && !attention.length && !unresolved.length && !localPendingCount && !device && !error) return null;
  function touch() { activity.current = Date.now(); if (paused) { setPaused(false); setRefresh(value => value + 1); } }
  function card(snapshot: IntakeSnapshot, handoffId?: string) { return <View key={handoffId ?? snapshot.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>{snapshot.store} · {snapshot.orderReference ? `Order ${snapshot.orderReference}` : 'Prepared order'}</Text>
    {snapshot.items.map((item, index) => <Text key={index} style={[styles.copy, { color: colors.textPrimary }]}>{intakeItemLabel(item)}</Text>)}
    <Text style={[styles.copy, { color: colors.textSecondary }]}>Ready to record · {snapshot.sourceKind === 'FORWARDED_EMAIL' ? 'Forwarded order email' : snapshot.sourceKind === 'BROWSER_CAPTURED' ? 'Selected on your computer' : 'Connected store'}</Text>
    <Button label="Record packing" icon="videocam-outline" disabled={captureBusy} onPress={() => { touch(); void app.startIntakeCapture({ snapshotId: snapshot.id, handoffId }); }} />
  </View>; }
  return <View onTouchStart={touch} style={styles.section}>
    <Text style={[styles.title, { color: colors.textPrimary }]}>Ready to record</Text>
    {localPendingCount > 0 ? <Button label={`Saved on this device · ${localPendingCount} ${localPendingCount === 1 ? "order" : "orders"}`} variant="secondary" disabled={captureBusy} onPress={() => app.go("intake")} /> : null}
    {cachedAt && !fresh ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Saved queue · {new Date(cachedAt).toLocaleString()} · Refresh before recording.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.copy, { color: colors.textSecondary }]}>{error}</Text> : null}
    {paused ? <Button label="Check for orders" variant="tertiary" onPress={touch} /> : null}
    {captureBusy && handoffs.length ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Your next order is waiting. Finish the current recording first.</Text> : null}
    {displayedHandoffs.map(row => card(row.orderSnapshot, row.id))}
    {ready.map(row => card(row.snapshot!))}
    {unresolved.map(submission => <SubmissionCard key={submission.submissionId} submission={submission} disabled={captureBusy} onChange={next => setSubmissions(previous => previous.map(row => row.submissionId === next.submissionId ? next : row))} />)}
    {attention.map(order => <ResolveOrder key={order.observationId} order={order} disabled={captureBusy} onResolved={result => { setOrders(previous => previous.map(row => row.observationId === order.observationId ? result : row)); }} />)}
    {!handoffs.length && !ready.length && device && !error ? <Text style={[styles.copy, { color: colors.textSecondary }]}>Waiting for an order from your computer.</Text> : null}
    <Button label="Refresh prepared orders" variant="tertiary" disabled={captureBusy} onPress={() => { touch(); setRefresh(value => value + 1); }} />
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 12 }, card: { padding: 16, borderWidth: 1, borderRadius: 8, gap: 8 }, title: { ...typography.bodyStrong }, copy: { ...typography.secondary } });
