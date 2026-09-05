import { useEffect, useRef, useState } from "react";
import { Alert, AppState, BackHandler, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import * as Sharing from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { UnifiedCameraView, isUnifiedCameraAvailable, type UnifiedCameraViewRef } from "../../modules/packproof-unified-camera";
import { beginSpikeRecording, createSpikeSession, endSpikeRecording, observeSpikeBarcode, serializeSpikeReport, stopSpikeDetection,
  type SpikeBarcodeEvent, type SpikeReport } from "../capture/camera-spike-model";
import { listSavedSpikes, saveSpikeReport, type SavedSpike } from "../capture/camera-spike-storage";
import { useTheme } from "../theme/ThemeProvider";
import { haptic } from "../theme/haptics";
import { Button } from "../ui/Button";
import { FadeSlideIn, PulseOpacity } from "../ui/motion";

type Phase = "READY" | "STARTING" | "RECORDING" | "SAVING";
const clock = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000) % 60 < 10 ? "0" : ""}${Math.floor(ms / 1000) % 60}`;

/** Standalone hardware spike. It has no API client, authentication, or Proof submission path. */
export function CameraSpikeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const camera = useRef<UnifiedCameraViewRef>(null);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [microphone, requestMicrophone] = useMicrophonePermissions();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const [phase, setPhase] = useState<Phase>("READY");
  const phaseRef = useRef<Phase>("READY");
  const [audio, setAudio] = useState(false), [torch, setTorch] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<SpikeBarcodeEvent | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [saved, setSaved] = useState<SavedSpike[]>([]);
  const [review, setReview] = useState<SavedSpike | null>(null);
  const session = useRef<ReturnType<typeof createSpikeSession> | null>(null);
  const clockStart = useRef(0);
  const mounted = useRef(true);
  const available = Platform.OS === "android" && isUnifiedCameraAvailable();

  function changePhase(next: Phase) { phaseRef.current = next; if (mounted.current) setPhase(next); }
  async function refreshSaved() {
    try { const items = await listSavedSpikes(); if (mounted.current) setSaved(items); }
    catch { if (mounted.current) setNotice("Saved tests could not be read. Existing files have been kept."); }
  }
  function checkpoint() {
    if (!session.current) return Promise.resolve(true);
    return saveSpikeReport(serializeSpikeReport(session.current)).then(() => true).catch(() => {
      if (mounted.current) setNotice("Test notes could not be saved. Recording continues; keep the app open after finishing.");
      return false;
    });
  }
  function stop() {
    if (phaseRef.current !== "RECORDING" && phaseRef.current !== "STARTING") return;
    if (session.current) stopSpikeDetection(session.current);
    changePhase("SAVING");
    void camera.current?.stopRecording().catch(() => {
      if (mounted.current) setNotice("The camera could not confirm stopping. Keep the app open while it finishes.");
    });
  }
  useEffect(() => {
    mounted.current = true;
    void refreshSaved();
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state === "active") void getPermission().catch(() => undefined);
      if (state !== "active") {
        setCameraReady(false);
        if (session.current && ["STARTING", "RECORDING"].includes(phaseRef.current)) {
          session.current.interrupted = true;
          stopSpikeDetection(session.current);
          changePhase("SAVING");
          void checkpoint();
          // Native lifecycle observer performs the stop even if JS is suspended here.
        }
      }
    });
    return () => { mounted.current = false; listener.remove(); };
  }, []);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (phaseRef.current === "SAVING") return true;
      if (["STARTING", "RECORDING"].includes(phaseRef.current)) {
        Alert.alert("Finish this test recording?", "The video will be saved before you leave the camera.", [
          {text: "Keep recording", style: "cancel"}, {text: "Finish and save", onPress: stop},
        ]);
        return true;
      }
      if (review) { setReview(null); setCameraReady(false); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [review]);
  useEffect(() => {
    if (phase !== "RECORDING") return;
    const timer = setInterval(() => {
      const next = Math.max(0, performance.now() - clockStart.current);
      setElapsed(next);
      if (next >= 600_000) stop();
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  async function start() {
    if (!camera.current || !cameraReady || phaseRef.current !== "READY" || !foreground) return;
    changePhase("STARTING");
    setNotice(null); setLastScan(null); setScanCount(0); setElapsed(0);
    const id = `spike-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    const current = createSpikeSession(id, audio);
    session.current = current;
    try {
      // First checkpoint must succeed before recording; later note failures never stop video.
      await saveSpikeReport(serializeSpikeReport(current));
      if (AppState.currentState !== "active" || !["STARTING"].includes(phaseRef.current)) {
        current.interrupted = true;
        await checkpoint();
        changePhase("READY");
        return;
      }
      const recording = await camera.current.startRecording(id, audio);
      changePhase("SAVING");
      endSpikeRecording(current, recording);
      const notesSaved = await checkpoint();
      if (mounted.current) {
        setNotice(!notesSaved ? "Test video was retained, but its final notes could not be saved. Check Saved tests and share the video before uninstalling." : current.interrupted ? "Recording was interrupted. Review the saved video before judging continuity." : "Test video saved. Play it back to check continuity and label timing.");
        setElapsed(recording.durationMs);
      }
    } catch {
      current.interrupted = true;
      stopSpikeDetection(current);
      await checkpoint();
      if (mounted.current) setNotice("This recording did not finish successfully. Any camera file was kept; check Saved tests.");
    } finally {
      changePhase("READY");
      await refreshSaved();
    }
  }

  async function toggleAudio() {
    if (audio) { setAudio(false); return; }
    try {
      const result = microphone?.granted ? microphone : await requestMicrophone();
      if (result.granted) setAudio(true);
      else setNotice("Microphone access was not granted. Silent video testing remains available.");
    } catch { setNotice("Microphone access could not be requested. Silent video testing remains available."); }
  }
  async function share(uri: string) {
    try { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri); else setNotice("Sharing is unavailable on this device."); }
    catch { setNotice("Sharing did not finish. The saved file is still on this device."); }
  }

  if (review) return <SpikeReview item={review} onClose={() => {setReview(null); setCameraReady(false);}} onShare={(uri) => void share(uri)} notice={notice} />;

  const busy = phase !== "READY";
  return <View style={[styles.root, {backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom}]}>
    <View style={styles.header}>
      <Text style={[styles.title, {color: colors.textPrimary}]}>Packing camera test</Text>
      <Text style={{color: colors.textSecondary}}>Local test only · no Proof is created · shipping is not attached</Text>
    </View>
    <View style={styles.camera}>
      {available && permission?.granted ? <UnifiedCameraView key={cameraKey} ref={camera} style={StyleSheet.absoluteFill}
        active={foreground} torchEnabled={torch}
        onReady={() => setCameraReady(true)}
        onRecordingStarted={({nativeEvent}) => {
          if (!session.current || session.current.startedAtUnixMs !== null || !["STARTING", "SAVING"].includes(phaseRef.current)) return;
          beginSpikeRecording(session.current, nativeEvent.startedAtUnixMs);
          if (phaseRef.current === "SAVING") { stopSpikeDetection(session.current); void checkpoint(); return; }
          clockStart.current = performance.now();
          changePhase("RECORDING");
          void checkpoint();
        }}
        onBarcodeDetected={({nativeEvent}) => {
          if (!session.current || phaseRef.current !== "RECORDING") return;
          const event = observeSpikeBarcode(session.current, nativeEvent);
          if (!event) return;
          setLastScan(event); setScanCount(session.current.events.length);
          void haptic("success");
          void checkpoint();
        }}
        onCaptureError={({nativeEvent}) => {
          if (!["BARCODE_ANALYSIS_FAILED", "TORCH_UNAVAILABLE"].includes(nativeEvent.code)) setCameraReady(false);
          setNotice(nativeEvent.code === "BARCODE_ANALYSIS_FAILED" ? "Barcode analysis had a problem. Video recording continues." : nativeEvent.code === "TORCH_UNAVAILABLE" ? "The torch could not change. Video recording can continue." : "The camera reported a problem. Finish any recording and review the saved test.");
        }}
      /> : <View style={styles.cameraMessage}><Text style={{color: "white", textAlign: "center"}}>{!available ? "Install the Android camera-test build to run this hardware test." : "Allow camera access to begin."}</Text></View>}
      <View pointerEvents="none" style={styles.overlay}>
        <PulseOpacity active={phase === "RECORDING"}><Text style={styles.rec}>{phase === "RECORDING" ? "● REC" : phase === "STARTING" ? "Starting…" : phase === "SAVING" ? "Saving…" : "CAMERA TEST"}  {clock(elapsed)}</Text></PulseOpacity>
        {lastScan ? <FadeSlideIn key={`${session.current?.sessionId}:${lastScan.detectionIndex}`} style={styles.scanChip}>
          <Text style={styles.scanTitle}>Barcode detected · {lastScan.maskedValue}</Text>
          <Text style={styles.scanText}>{lastScan.format} · video ~{clock(lastScan.detectedAtMs)} · {scanCount} distinct read{scanCount === 1 ? "" : "s"}</Text>
          <Text style={styles.scanText}>Recognition only · carrier not confirmed</Text>
        </FadeSlideIn> : null}
      </View>
    </View>
    <ScrollView style={styles.controlsScroll} contentContainerStyle={styles.controls}>
      {notice ? <Text accessibilityRole="alert" style={{color: colors.textPrimary}}>{notice}</Text> : null}
      {!permission?.granted && available ? <Button label={permission?.canAskAgain === false ? "Open camera settings" : "Allow camera"} onPress={() => void (permission?.canAskAgain === false ? Linking.openSettings() : requestPermission()).catch(() => setNotice("Camera permission could not be requested."))} /> : null}
      {busy ? <Button label="Finish and save video" loading={phase === "SAVING"} disabled={phase === "STARTING"} onPress={stop} /> : <Button label="Start test recording" disabled={!available || !permission?.granted || !cameraReady || !foreground} onPress={() => void start()} />}
      {!busy && available && permission?.granted && !cameraReady ? <Button label="Retry camera" variant="secondary" onPress={() => {setNotice(null); setCameraKey((value) => value + 1);}} /> : null}
      <View style={styles.row}>
        <View style={styles.grow}><Button label={torch ? "Torch off" : "Torch on"} variant="secondary" disabled={!cameraReady || phase === "SAVING"} onPress={() => setTorch(!torch)} /></View>
        <View style={styles.grow}><Button label={audio ? "Audio on" : "Silent video"} variant="secondary" disabled={busy} onPress={() => void toggleAudio()} /></View>
      </View>
      <Text style={{color: colors.textSecondary}}>Record for 2–5 minutes. Show test labels, leave one visible for 10 seconds, and check playback afterward. Backgrounding ends the recording; it never resumes as a continuous clip. Maximum 10 minutes.</Text>
      {saved.length ? <Text style={[styles.subtitle, {color: colors.textPrimary}]}>Saved tests</Text> : null}
      {saved.map((item) => <Button key={item.sessionId} disabled={busy} variant="secondary" label={`${new Date(Number(item.sessionId.split("-")[1])).toLocaleString()} · ${item.recoveryWarning ? "Inspect interrupted test" : "Review video and scans"}`} onPress={() => {setReview(item); setCameraReady(false); setTorch(false);}} />)}
    </ScrollView>
  </View>;
}

function SpikeReview({item, onClose, onShare, notice}: {item: SavedSpike; onClose: () => void; onShare: (uri: string) => void; notice: string | null}) {
  const {colors} = useTheme();
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(item.videoUri);
  const [playerError, setPlayerError] = useState(false);
  useEffect(() => {const listener = player.addListener("statusChange", (event) => {if (event.status === "error") setPlayerError(true);}); return () => listener.remove();}, [player]);
  const report: SpikeReport | null = item.report;
  return <ScrollView style={{backgroundColor: colors.background}} contentContainerStyle={[styles.controls, {paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16}]}>
    <Text style={[styles.title, {color: colors.textPrimary}]}>Review camera test</Text>
    <Text style={{color: colors.textSecondary}}>Hardware validation is pending. This test does not establish shipping identity or Proof integrity.</Text>
    {notice ? <Text style={{color: colors.textPrimary}}>{notice}</Text> : null}
    {item.recoveryWarning ? <Text style={{color: colors.error}}>This session was interrupted or did not finish saving its notes. A recovered file may be incomplete. Check playback; do not count it as continuous evidence.</Text> : null}
    {item.videoUri ? <VideoView player={player} style={styles.playback} nativeControls contentFit="contain" /> : <Text style={{color: colors.error}}>No non-empty video file was found for this test.</Text>}
    {playerError ? <Text style={{color: colors.error}}>This video could not be played. Keep the file for diagnosis and repeat the test.</Text> : null}
    <Text style={{color: colors.textSecondary}}>{report?.recording ? `${clock(report.recording.durationMs)} recorded · ${report.events.length} distinct barcode reads` : "Final video duration was not confirmed."}</Text>
    {(report?.events ?? []).map((event) => <Button key={event.detectionIndex} variant="secondary" disabled={!item.videoUri || playerError} label={`Jump to barcode · ~${clock(event.detectedAtMs)} · ${event.maskedValue}`} onPress={() => {player.currentTime = event.detectedAtMs / 1000; player.play();}} />)}
    <Text style={{color: colors.textSecondary}}>Scan times are approximate native capture offsets. Playback is the check for actual continuity and timing. Reports contain masked barcode data; the video still shows whatever was in frame.</Text>
    {item.reportUri ? <Button label="Share masked test report" variant="secondary" onPress={() => onShare(item.reportUri!)} /> : null}
    {item.videoUri ? <Button label="Share test video" variant="secondary" onPress={() => onShare(item.videoUri!)} /> : null}
    <Button label="Back to camera test" onPress={onClose} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: {flex: 1}, header: {padding: 16, gap: 6}, title: {fontSize: 23, fontWeight: "700"}, subtitle: {fontSize: 18, fontWeight: "600"},
  camera: {flex: 1, minHeight: 240, backgroundColor: "#101B2B"}, cameraMessage: {flex: 1, justifyContent: "center", padding: 20},
  overlay: {position: "absolute", left: 16, right: 16, top: 16, bottom: 16, justifyContent: "space-between"},
  rec: {color: "white", fontWeight: "700", backgroundColor: "#101B2BCC", alignSelf: "flex-start", padding: 8, borderRadius: 10},
  scanChip: {backgroundColor: "#D6F4EC", padding: 14, borderRadius: 16, gap: 4}, scanTitle: {color: "#124337", fontWeight: "700"}, scanText: {color: "#124337", fontSize: 12},
  controlsScroll: {flexGrow: 0, maxHeight: "44%"}, controls: {padding: 16, gap: 12}, row: {flexDirection: "row", gap: 12}, grow: {flex: 1}, playback: {height: 320, backgroundColor: "#101B2B"},
});
