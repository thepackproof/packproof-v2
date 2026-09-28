import { AppModal } from "../ui/AppModal";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { usePackProof } from '../app/PackProofProvider';
import { listAccountCaptures, recordPackingEvidence, requestCapturePermissions, type LocalCapture } from '../capture';
import { isUnifiedCameraAvailable } from '../../modules/packproof-unified-camera';
import { stopRemoteCapture } from '../capture/remote-control';
import { PACKPROOF_WEB_ORIGIN } from '../copy/legal';
import { newIdempotencyKey, type FulfillmentQueueItem } from '../v2-api';
import { useTheme } from '../theme/ThemeProvider';
import { AppHeader } from '../ui/AppHeader';
import { AppScreen } from '../ui/AppScreen';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/EmptyState';
import { FormField } from '../ui/FormField';
import { BarcodeScanView } from '../screens/BarcodeScanView';
import { canSelectRelayOrder, parseRelayPairing, readRelayDevice, readRelayStation, relayStorageKey, RelayScope, sendRelayCommand, type RelayAck, type RelayDevice, type RelayStation } from './model';

type Lease = ReturnType<RelayScope['lease']>;
const listeners = new Set<() => void>();
export function openRelayStation() { listeners.forEach(open => open()); }
/** Mount once under the signed-in root, including during capture and review navigation. */
export function RelayStationHost() {
  const app = usePackProof(), instance = useMemo(() => newIdempotencyKey(), [app.client]);
  return app.session ? <AccountRelayStation key={`${instance}:${app.session.userId}`} /> : null;
}
function AccountRelayStation() {
  const app = usePackProof(), { colors } = useTheme(), userId = app.session!.userId;
  const appRef = useRef(app); appRef.current = app;
  const scope = useMemo(() => new RelayScope(app.client, userId), [app.client, userId]);
  const [visible, setVisible] = useState(false), [hydrated, setHydrated] = useState(false), [device, setDevice] = useState<RelayDevice | null>(null), [station, setStation] = useState<RelayStation | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState(''), [armed, setArmed] = useState(false), [pairing, setPairing] = useState(''), [scan, setScan] = useState(''), [scanning, setScanning] = useState<'pair' | 'command' | null>(null);
  const [queue, setQueue] = useState<FulfillmentQueueItem[]>([]), [selected, setSelected] = useState<{ id: string; title: string } | null>(null), [saved, setSaved] = useState<LocalCapture | null>(null), [recording, setRecording] = useState(false);
  const deviceRef = useRef<RelayDevice | null>(null), stationRef = useRef<RelayStation | null>(null), armedRef = useRef(false), selectedRef = useRef(selected);
  const polling = useRef(false), acting = useRef(false), cameraTask = useRef<Promise<void> | null>(null), cameraId = useRef<string | null>(null), foreground = useRef(AppState.currentState === 'active'), mounted = useRef(true);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const writes = useRef<Promise<void>>(Promise.resolve()), storageKey = relayStorageKey(app.client.apiBaseUrl, userId);
  const secondary = { color: colors.textSecondary }, body = { color: colors.textPrimary };
  function showStation(value: RelayStation) { stationRef.current = value; setStation(value); }
  async function persist(value: RelayDevice | null, assert: () => void) {
    assert(); deviceRef.current = value; setDevice(value);
    const encoded = value ? JSON.stringify(value) : null;
    const write = writes.current.catch(() => undefined).then(async () => { assert(); if (encoded === null) await AsyncStorage.removeItem(storageKey); else await AsyncStorage.setItem(storageKey, encoded); });
    writes.current = write; await write; assert();
  }
  async function loadQueue(lease: Lease) { const result = await app.client.listFulfillmentQueue('ready'); lease.assert(); setQueue(result.items.filter(row => !['COMPLETED', 'REMOVED_FROM_FULFILLMENT'].includes(row.workflowState))); }
  async function action(work: (lease: Lease) => Promise<void>) {
    if (acting.current) return; acting.current = true; setBusy(true); setError(null); setNotice('');
    let lease: Lease | null = null;
    try { lease = scope.lease(); await appRef.current.ensureAuth(); lease.assert(); await work(lease); }
    catch (reason) { try { lease?.assert(); if (mounted.current) setError(reason instanceof Error ? reason.message : 'Station action could not finish. Retry the same action.'); } catch { /* Old account/foreground response. */ } }
    finally { acting.current = false; try { lease?.assert(); if (mounted.current) setBusy(false); } catch { /* New foreground owns UI. */ } }
  }
  useEffect(() => {
    mounted.current = true; scope.setForeground(foreground.current);
    async function restore() {
      try { const lease = scope.lease(); const existing = readRelayDevice(await AsyncStorage.getItem(storageKey)); lease.assert(); deviceRef.current = existing; setDevice(existing); setHydrated(true); await loadQueue(lease); }
      catch (reason) { if (mounted.current && foreground.current) { setError(reason instanceof Error ? reason.message : 'The saved station could not be opened.'); setHydrated(true); } }
    }
    const show = () => setVisible(true); listeners.add(show);
    const state = AppState.addEventListener('change', value => { foreground.current = value === 'active'; scope.setForeground(foreground.current); armedRef.current = false; setArmed(false); setScanning(null); if (foreground.current) { setBusy(false); if (!deviceRef.current) void restore(); } });
    function receive(value: string) { if (parseRelayPairing(value)) { setPairing(value); setVisible(true); } }
    const links = Linking.addEventListener('url', event => receive(event.url));
    void Linking.getInitialURL().then(value => { if (mounted.current && value) receive(value); }).catch(() => undefined);
    void restore();
    return () => { mounted.current = false; scope.dispose(); listeners.delete(show); state.remove(); links.remove(); };
  }, [scope]);
  async function acknowledge(ack: RelayAck, lease: Lease) {
    const d = deviceRef.current; if (!d || d.role !== 'CAMERA') return;
    await persist({ ...d, pendingAck: ack }, lease.assert);
    await lease.request(`/${d.id}/ack`, 'POST', ack, d.token);
    const latest = deviceRef.current!;
    await persist({ ...latest, pendingAck: undefined, ...(latest.pendingStart?.sequence === ack.sequence ? { pendingStart: undefined } : {}) }, lease.assert);
  }
  async function selectCameraOrder(proofId: string, lease: Lease) {
    if (cameraTask.current) throw new Error('Finish the current recording before selecting another order.');
    if (appRef.current.localCapture && appRef.current.localCapture.captureProofId !== proofId) throw new Error('Finish saving the recording already open on this phone before changing orders.');
    const proof = await app.client.getProof(proofId); lease.assert();
    if (proof.workflowType === 'GRADING_SUBMISSION') throw new Error('Open this grading workflow directly to use its required capture steps.');
    const next = { id: proofId, title: proof.transaction.itemTitle || proof.transaction.externalReference || 'Selected order' };
    selectedRef.current = next; setSelected(next); setSaved(null);
  }
  function launchCamera(sequence: number, proofId: string, lease: Lease) {
    if (cameraTask.current) return;
    if (!isUnifiedCameraAvailable()) throw new Error('Update PackProof to use the native camera with remote controls.');
    if (!armedRef.current) throw new Error('The controller requested recording. Enable this camera to continue.');
    if (selectedRef.current?.id !== proofId) throw new Error('Camera and controller orders differ. Confirm the selected order on this phone.');
    if (appRef.current.localCapture) throw new Error('Review or finish the saved recording already open on this phone before recording again.');
    const dismissingPanel = visibleRef.current;
    setVisible(false); setRecording(true);
    cameraTask.current = (async () => {
      if (dismissingPanel) await new Promise<void>(resolve => setTimeout(resolve, 350));
      lease.assert();
      const capture = await recordPackingEvidence({ client: app.client, proofId, userId, orderLabel: selectedRef.current!.title, autoStart: true, relay: {
        onSessionIssued: async captureSessionId => { lease.assert(); cameraId.current = captureSessionId; const d = deviceRef.current; if (!d) throw new Error('The paired station changed.'); await persist({ ...d, pendingStart: { sequence, captureSessionId, proofId } }, lease.assert); },
        onRecordingStarted: () => {
          // Recording status follows the actual native start callback, never session issuance.
          void (async () => { const current = scope.lease(), d = deviceRef.current; if (d?.pendingStart?.sequence === sequence) await persist({ ...d, pendingAck: { sequence, captureSessionId: d.pendingStart.captureSessionId } }, current.assert); })().catch(() => undefined);
        },
      } });
      if (!capture) throw new Error('The camera did not save a recording. Check Recordings on this device before retrying.');
      const current = scope.lease(); current.assert(); setSaved(capture); setNotice('Recording saved on this phone. Review labels and confirm it before the next order.');
      await appRef.current.resumeSavedCapture(capture);
    })().catch(reason => { try { scope.lease().assert(); setError(reason instanceof Error ? reason.message : 'Recording needs attention on this phone.'); setVisible(true); } catch { /* Account-bound capture metadata remains recoverable. */ } }).finally(() => { cameraTask.current = null; cameraId.current = null; if (mounted.current) setRecording(false); });
  }
  useEffect(() => {
    if (!device?.id || !hydrated) return;
    let alive = true;
    async function poll() {
      if (!alive || !foreground.current || polling.current || acting.current) return;
      polling.current = true; let lease: Lease | null = null;
      try {
        lease = scope.lease(); const d = deviceRef.current; if (!d) return;
        const next = readRelayStation(await lease.request(`/${d.id}`, 'GET', undefined, d.token), d.id); if (!alive) return; showStation(next);
        if (d.role !== 'CAMERA') return;
        if (d.pendingAck) { await acknowledge(d.pendingAck, lease); return; }
        if (d.pendingStart && !cameraTask.current) {
          const captures = await listAccountCaptures(app.client.apiBaseUrl, userId); lease.assert();
          const capture = captures.find(item => item.captureSessionId === d.pendingStart!.captureSessionId && item.captureProofId === d.pendingStart!.proofId && item.recovery?.phase !== 'RECORDING' && item.localFileAvailable !== false);
          if (!capture) { setError('A previous Start needs attention on this phone. Open Recordings on this device; no new take will replace it automatically.'); return; }
          setSaved(capture); await acknowledge({ sequence: d.pendingStart.sequence, captureSessionId: d.pendingStart.captureSessionId }, lease); return;
        }
        const command = next.commands[0]; if (!command) return;
        if (command.type === 'SELECT_ORDER' || command.type === 'NEXT') {
          if (!command.proofId || command.proofId !== next.proofId) throw new Error('The selected order does not match the controller.');
          await selectCameraOrder(command.proofId, lease); await acknowledge({ sequence: command.sequence }, lease);
        } else if (command.type === 'START') {
          if (!next.proofId || (command.proofId && command.proofId !== next.proofId)) throw new Error('The Start command does not match the selected order.');
          if (!selectedRef.current) await selectCameraOrder(next.proofId, lease);
          launchCamera(command.sequence, next.proofId, lease);
        } else {
          if (!next.captureSessionId || !next.proofId || (command.proofId && command.proofId !== next.proofId)) throw new Error('The Finish command does not match this recording.');
          if (cameraId.current && cameraId.current !== next.captureSessionId) throw new Error('A different recording is open on this phone.');
          if (cameraTask.current) { stopRemoteCapture(next.captureSessionId); return; }
          if (!['RECORDED', 'UPLOADING', 'COMMITTED'].includes(next.capture?.state || '')) { setNotice('Finish reviewing and saving on this phone. The controller keeps this order selected.'); return; }
          await acknowledge({ sequence: command.sequence }, lease);
        }
      } catch (reason) { try { lease?.assert(); if (alive) { if ((reason as { code?: string })?.code === 'RELAY_LEASE_EXPIRED') setExpired(true); setError(reason instanceof Error ? reason.message : 'Station connection unavailable. The selected order is preserved.'); } } catch { /* Stale response. */ } }
      finally { polling.current = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [device?.id, device?.role, hydrated, scope]);
  async function send(type: 'SELECT_ORDER' | 'START' | 'FINISH' | 'NEXT', proofId: string | undefined, lease: Lease) {
    const d = deviceRef.current, current = stationRef.current; if (!d || !current) throw new Error('Refresh the paired station first.');
    await sendRelayCommand({ device: d, station: current, type, proofId, key: newIdempotencyKey(), persist: value => persist(value, lease.assert), request: lease.request });
    showStation(readRelayStation(await lease.request(`/${d.id}`, 'GET', undefined, d.token), d.id));
  }
  function useScan(value: string) {
    setScan(value); setScanning(null); void action(async lease => {
      if (value.trim() === 'PP:START') await send('START', undefined, lease);
      else if (value.trim() === 'PP:FINISH') await send('FINISH', undefined, lease);
      else { const found = await app.client.resolvePackingStation(value.trim()); lease.assert(); const proof = await app.client.createOrGetProof(found.transactionId); lease.assert(); await send(stationRef.current?.proofId ? 'NEXT' : 'SELECT_ORDER', proof.proofId, lease); }
      setScan('');
    });
  }
  const waiting = !!station && station.lastSequence !== station.acknowledgedSequence, locked = busy || !hydrated;
  const canLeave = !recording && (expired || (!waiting && !device?.pendingAck && !device?.pendingCommand && !device?.pendingStart && (!['RECORDING', 'SAVING'].includes(station?.state || '') || station?.capture?.state === 'COMMITTED') && (!station?.captureSessionId || station.capture?.state === 'COMMITTED')));
  const scanner = <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.background }}>
      <BarcodeScanView prompt={scanning === 'pair' ? 'Scan the controller’s pairing QR code' : 'Scan an order reference or station command'} lockKey={scanning || ''} onCancel={() => setScanning(null)} onPermissionDenied={() => { setScanning(null); setError('Allow camera access in Settings or paste the reference instead.'); }} onUnavailable={() => { setScanning(null); setError('Scanning is unavailable. Paste the reference instead.'); }} onDecoded={value => { if (scanning === 'pair') { setScanning(null); if (parseRelayPairing(value)) setPairing(value); else setError('This is not a PackProof camera pairing link.'); } else useScan(value); }} />
    </View>;
  return <>
    {device && !visible && !recording ? <View style={{ paddingHorizontal: 16, backgroundColor: colors.surface }}><Button label={`Remote camera · ${device.role === 'CAMERA' ? 'This phone' : 'Controller'}`} variant="tertiary" onPress={() => setVisible(true)} /></View> : null}
    <AppModal visible={visible} animationType="slide" onRequestClose={() => scanning ? setScanning(null) : setVisible(false)}>{scanning ? scanner : <AppScreen extraBottom={24}>
      <AppHeader title="Remote camera controls" onBack={() => setVisible(false)} />
      <Text style={secondary}>Pair one controller with one phone camera, signed in to the same account. Pairing links expire in five minutes. Station access lasts eight hours.</Text>
      <ErrorBanner message={error} />
      {notice ? <Text accessibilityLiveRegion="polite" style={secondary}>{notice}</Text> : null}
      {!device ? <>
        <Button label="Use this device as controller" disabled={locked} onPress={() => void action(async lease => {
          const raw = await lease.request<RelayStation & { controllerToken: string; pairingToken: string }>('', 'POST', {}), created = readRelayStation(raw);
          const pairingUrl = `${PACKPROOF_WEB_ORIGIN}/station#relay=${encodeURIComponent(created.id)}&pair=${encodeURIComponent(raw.pairingToken)}`;
          const value = readRelayDevice(JSON.stringify({ version: 1, id: created.id, role: 'CONTROLLER', token: raw.controllerToken, pairingUrl }));
          if (!value || !parseRelayPairing(pairingUrl)) throw new Error('Station pairing could not be verified. Create another station.');
          await persist(value, lease.assert); showStation(created);
        })} />
        <FormField label="Pairing link from the controller" value={pairing} onChangeText={setPairing} editable={!locked} autoCapitalize="none" />
        <Button label="Scan pairing QR code" variant="secondary" disabled={locked} onPress={() => setScanning('pair')} />
        <Button label="Pair this phone camera" disabled={locked || !parseRelayPairing(pairing)} onPress={() => void action(async lease => {
          const pair = parseRelayPairing(pairing); if (!pair) throw new Error('Paste or scan the full PackProof station pairing link.');
          const raw = await lease.request<RelayStation & { cameraToken: string }>(`/${pair.id}/pair`, 'POST', { pairingToken: pair.token });
          const next = readRelayStation(raw, pair.id), value = readRelayDevice(JSON.stringify({ version: 1, id: pair.id, role: 'CAMERA', token: raw.cameraToken }));
          await persist(value, lease.assert); showStation(next); setPairing(''); setNotice('Phone paired. Enable this camera before the controller can start recording.');
        })} />
      </> : <>
        <Text accessibilityLiveRegion="polite" style={body}>{device.role === 'CAMERA' ? 'Phone camera' : 'Controller'} · {station?.state.toLowerCase().replaceAll('_', ' ') || 'Reconnecting…'}{waiting ? ' · Waiting for camera acknowledgement' : ''}</Text>
        {device.role === 'CONTROLLER' && !station?.paired && device.pairingUrl ? <>
          <Text style={secondary}>Send this link to your signed-in phone. Open Remote camera controls there, paste the link, and choose Pair this phone camera.</Text>
          <Button label="Share camera pairing link" variant="secondary" onPress={() => void Share.share({ message: device.pairingUrl! })} />
          <Button label="Copy camera pairing link" variant="tertiary" onPress={() => void Clipboard.setStringAsync(device.pairingUrl!)} />
        </> : null}
        {device.role === 'CAMERA' ? <>
          <Text style={body}>{selected?.title || (station?.proofId ? 'Controller order selected' : 'Waiting for an order')}</Text>
          <Button label={armed ? 'Disable controller Start' : 'Enable controller Start and Finish'} variant={armed ? 'secondary' : 'primary'} disabled={locked || recording} onPress={() => void action(async lease => { if (armedRef.current) { armedRef.current = false; setArmed(false); return; } await requestCapturePermissions(); lease.assert(); armedRef.current = true; setArmed(true); setError(null); })} />
          <Text style={secondary}>Keep PackProof open and this phone awake. Leaving the app disables new remote starts. Review and biometric confirmation stay on this phone.</Text>
          {saved ? <Button label="Review saved recording" disabled={locked || recording} onPress={() => void action(async lease => { lease.assert(); setVisible(false); await app.resumeSavedCapture(saved); })} /> : null}
        </> : station?.paired ? <>
          <Text style={body}>Order for both devices</Text>
          {queue.map(item => <Button key={item.proofId} label={`${item.externalReference || item.externalOrderId || 'Order'} · ${item.itemSummary || 'Shipment'}${station.proofId === item.proofId ? ' · Selected' : ''}`} variant="secondary" disabled={locked || !!device.pendingCommand || !canSelectRelayOrder(station)} onPress={() => void action(lease => send(station.proofId ? 'NEXT' : 'SELECT_ORDER', item.proofId, lease))} />)}
          <Button label="Refresh available orders" variant="tertiary" disabled={locked} onPress={() => void action(loadQueue)} />
          <FormField label="Order reference or PP:START / PP:FINISH" value={scan} onChangeText={setScan} editable={!locked && !waiting} autoCapitalize="none" />
          <Button label="Use reference or command" variant="secondary" disabled={locked || waiting || !!device.pendingCommand || !scan.trim()} onPress={() => useScan(scan)} />
          <Button label="Scan reference or command" variant="tertiary" disabled={locked || waiting || !!device.pendingCommand} onPress={() => setScanning('command')} />
          <Button label="Start phone recording" disabled={locked || waiting || !!device.pendingCommand || station.state !== 'SELECTED'} onPress={() => void action(lease => send('START', undefined, lease))} />
          <Button label="Finish phone recording" disabled={locked || waiting || !!device.pendingCommand || station.state !== 'RECORDING'} onPress={() => void action(lease => send('FINISH', undefined, lease))} />
          {device.pendingCommand ? <Button label="Retry the same command" variant="secondary" disabled={locked} onPress={() => void action(lease => send(device.pendingCommand!.type, undefined, lease))} /> : null}
          <Text style={secondary}>{station.capture?.state === 'COMMITTED' ? 'Recording saved. You can select the next order.' : 'The next order stays locked until the recording phone finishes review and upload.'}</Text>
        </> : null}
        <Button label="Renew station session" variant="secondary" disabled={locked} onPress={() => void action(async lease => { await lease.request(`/${device.id}/renew`, 'POST', {}, device.token); setNotice('Station access renewed.'); })} />
        <Button label={expired ? "Forget expired station" : "Leave paired mode"} variant="tertiary" disabled={locked || !canLeave} onPress={() => Alert.alert('Leave paired mode?', 'This device will forget station access. Saved recordings remain in their original Proofs.', [{ text: 'Keep paired', style: 'cancel' }, { text: 'Leave', onPress: () => void action(async lease => { await persist(null, lease.assert); stationRef.current = null; setStation(null); setExpired(false); selectedRef.current = null; setSelected(null); armedRef.current = false; setArmed(false); setError(null); }) }])} />
      </>}
    </AppScreen>}</AppModal>

  </>;
}
