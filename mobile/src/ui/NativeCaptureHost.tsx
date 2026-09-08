import { haptic } from "../theme/haptics";
import { UnifiedCameraView, isUnifiedCameraAvailable, type UnifiedCameraViewRef, type UnifiedBarcodeDetection } from "../../modules/packproof-unified-camera";
import { newIdempotencyKey } from "../v2-api";
import { shortenedTracking, type ShippingScanResult } from "../capture/shipping-scan-queue";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  registerNativeRecorder,
  type CaptureBookmark,
  type LocalCapture,
  type NativeRecordingRequest,
} from "../capture";
import { Button } from "./Button";
import { useTheme } from "../theme/ThemeProvider";

const packingRecipe = [
  {
    label: "Item view",
    hint: "Keep the whole item in frame. Use even light and avoid glare.",
  },
  {
    label: "Identifier",
    hint: "Move close enough to read the identifier, then hold steady.",
  },
  {
    label: "Packing",
    hint: "Show the item going into the packaging without leaving the frame.",
  },
  { label: "Closed box", hint: "Show the closed package and its seal." },
  {
    label: "Shipping label",
    hint: "Keep the label readable. Review sharing privacy before sending.",
  },
];

const receivingRecipe = [
  {
    label: "Unopened package",
    hint: "Show the package and seals before opening it.",
  },
  { label: "Opening", hint: "Keep the package in frame as you open it." },
  {
    label: "Item view",
    hint: "Show the item and included accessories in even light.",
  },
  {
    label: "Identifier",
    hint: "Move close enough to read the identifier, then hold steady.",
  },
  {
    label: "Visible condition",
    hint: "Show useful angles. Describe uncertain or missing views without inferring a cause.",
  },
];

type Request = NativeRecordingRequest & {
  resolve: (capture: LocalCapture | null) => void;
  reject: (error: Error) => void;
};

/** The recorder is a first-party camera surface; this host never accepts an external file. */
export function NativeCaptureHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const active = useRef<Request | null>(null);
  useEffect(
    () =>
      registerNativeRecorder(
        (value) =>
          new Promise((resolve, reject) => {
            if (active.current) {
              reject(new Error("A recording is already in progress."));
              return;
            }
            active.current = { ...value, resolve, reject };
            setRequest(active.current);
          }),
      ),
    [],
  );
  useEffect(
    () => () => {
      active.current?.reject(
        new Error(
          "Capture was interrupted. Check saved work before starting again.",
        ),
      );
      active.current = null;
    },
    [],
  );
  if (!request) return null;
  const finish = (result: LocalCapture | null) => {
    active.current = null;
    setRequest(null);
    request.resolve(result);
  };
  return (
    <CameraSession
      key={request.captureSessionId ?? request.proofId}
      request={request}
      onFinish={finish}
    />
  );
}

function CameraSession({
  request,
  onFinish,
}: {
  request: Request;
  onFinish: (result: LocalCapture | null) => void;
}) {
  const camera = useRef<CameraView>(null);
  const unifiedCamera = useRef<UnifiedCameraViewRef>(null);
  const useUnified = isUnifiedCameraAvailable() && Boolean(request.captureSessionId);
  const [shipping, setShipping] = useState<ShippingScanResult|null>(null);
  const [detectingShipping,setDetectingShipping] = useState(false);
  const [shippingError,setShippingError] = useState<string|null>(null);
  const notified = useRef(new Set<string>());
  const observed = useRef(new Set<string>());
  async function detected(event: UnifiedBarcodeDetection) {
    if (!recordingRef.current || !request.onShippingBarcode) return;
    if (/EAN|UPC/i.test(event.format) || !/^[a-z0-9 \t\r\n-]{10,64}$/i.test(event.rawValue)) return;
    const key=event.rawValue.replace(/[ \t\r\n-]/g,'').toUpperCase();
    if(observed.current.has(key) || observed.current.size>=8) return;
    observed.current.add(key);
    setDetectingShipping(true);
    try {
      const result = await request.onShippingBarcode({rawValue:event.rawValue,format:event.format,detectedAtMs:Math.floor(event.detectedAtMs),idempotencyKey:newIdempotencyKey(),
        source:event.source,coordinateSpace:event.coordinateSpace,decoderVersion:event.decoderVersion,observedAtUnixMs:event.detectedAtUnixMs,
        frameWidth:event.frameWidth,frameHeight:event.frameHeight,bounds:event.bounds});
      if (result.status==='UNRECOGNIZED') return;
      setShipping(result);
      if (!notified.current.has(key)) {
        notified.current.add(key);
        void haptic("selection");
      }
    } catch {
      setShippingError('Keep recording. We’ll check the label at review.');
    } finally {setDetectingShipping(false);}
  }
  const recipe =
    request.stageType && request.stageType !== "RETURN_PACKING"
      ? receivingRecipe
      : packingRecipe;
  const { colors, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false),
    [recording, setRecording] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [coach, setCoach] = useState(true),
    [elapsed, setElapsed] = useState(0);
  const started = useRef(0),
    recordingRef = useRef(false),
    interrupted = useRef(false),
    bookmarks = useRef<CaptureBookmark[]>([]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setElapsed(Date.now() - started.current),
      500,
    );
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active" && recordingRef.current) {
        interrupted.current = true;
        if (useUnified) void unifiedCamera.current?.stopRecording().catch(()=>undefined);
        else camera.current?.stopRecording();
      }
    });
    return () => listener.remove();
  }, []);
  async function start() {
    if (!(useUnified ? unifiedCamera.current : camera.current) || !ready || recordingRef.current) return;
    if (request.expiresAt && Date.now() >= Date.parse(request.expiresAt)) {
      setError(
        "This camera authorization expired before recording began. Cancel and reopen the camera to continue.",
      );
      return;
    }
    setError(null);
    bookmarks.current = [];
    interrupted.current = false;
    started.current = Date.now();
    recordingRef.current = true;
    setRecording(true);
    try {
      const video = useUnified
        ? await unifiedCamera.current!.startRecording(request.captureSessionId!, false)
        : await camera.current!.recordAsync({ maxDuration: 300 });
      setSaving(true);
      void haptic("light");
      if (!video?.uri)
        throw new Error(
          "The camera returned no recording. No save was confirmed.",
        );
      const durationMs = video && "durationMs" in video && typeof video.durationMs === "number" ? video.durationMs : Math.max(1, Date.now() - started.current);
      request.onRecordingStopped?.();
      onFinish({
        uri: video.uri,
        contentType: Platform.OS === "ios" ? "video/quicktime" : "video/mp4",
        byteSize: "byteSize" in video && typeof video.byteSize === "number" ? video.byteSize : null,
        durationMs,
        bookmarks: bookmarks.current
          .filter((bookmark) => bookmark.startMs < durationMs)
          .map((bookmark) => ({
            ...bookmark,
            endMs: Math.min(bookmark.endMs, durationMs),
          })),
        interrupted: interrupted.current || ("interrupted" in video && video.interrupted === true),
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Recording failed. Try the camera again.",
      );
    } finally {
      recordingRef.current = false;
      setRecording(false);
      setSaving(false);
    }
  }
  const acceptedStart = useRef(false);
  useEffect(() => {
    // Only an explicit intake Record action sets autoStart. Handoff polling never does.
    if (request.autoStart && ready && !acceptedStart.current && !recordingRef.current && AppState.currentState === "active") {
      acceptedStart.current = true;
      void start();
    }
  }, [ready, request.autoStart]);
  const stop = () => {
    if (recordingRef.current) {
      setSaving(true);
      if (useUnified) void unifiedCamera.current?.stopRecording().catch(()=>setError("Could not request camera stop. Close the camera to preserve the recording."));
      else camera.current?.stopRecording();
    }
  };
  return (
    <Modal
      visible
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={() => recordingRef.current ? Alert.alert("Finish this recording?", "Keep recording or finish and review what you recorded.", [{text:"Keep recording",style:"cancel"},{text:"Finish recording",onPress:stop}]) : saving ? undefined : onFinish(null)}
    >
      <View
        style={[
          styles.root,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.heading}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {recording
              ? request.stageType
                ? "Recording receipt / return"
                : "Recording packing"
              : "Record packing"}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {request.orderLabel}
          </Text>
          {request.compatibilityWorkflow ? <Text style={{ color: colors.textSecondary }}>
            Grading workflow recording · the existing grading recipe and participant checks apply.
          </Text> : null}
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: colors.textSecondary }}
          >
            {recording
              ? `● Recording · ${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}${elapsed >= 270000 ? " · under 30 seconds left" : ""}`
              : "Camera recording · up to 5 minutes · audio is not required"}
          </Text>
        </View>
        <View style={styles.camera}>
          {useUnified ? <UnifiedCameraView
            ref={unifiedCamera}
            style={StyleSheet.absoluteFill}
            active
            torchEnabled={false}
            onReady={()=>setReady(true)}
            onRecordingStarted={({nativeEvent})=>{started.current=nativeEvent.startedAtUnixMs;request.onRecordingStarted?.(); void haptic("medium");}}
            onBarcodeDetected={({nativeEvent})=>{void detected(nativeEvent);}}
            onCaptureError={({nativeEvent})=>{
              if (recordingRef.current) setShippingError('Label scanning is unavailable. Your recording is continuing.');
              else {setReady(false);setError(nativeEvent.message);}
            }}
          /> : <CameraView
            ref={camera}
            style={StyleSheet.absoluteFill}
            mode="video"
            facing="back"
            mute
            videoQuality="720p"
            onCameraReady={() => setReady(true)}
            onMountError={(event) => {
              setReady(false);
              setError(event.message);
            }}
          />
          }
          {request.guide ? (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Image
                source={request.guide}
                style={[StyleSheet.absoluteFill, { opacity: 0.3 }]}
                resizeMode="contain"
                accessibilityLabel="Outbound frame alignment guide; this overlay is not recorded"
              />
            </View>
          ) : null}
          {coach ? <View pointerEvents="none" style={styles.frame} /> : null}
        </View>
        <ScrollView contentContainerStyle={styles.controls}>
          {useUnified ? <View accessibilityLiveRegion="polite" style={{gap:6}}>
            <Text style={{color:shipping?.status==='BOUND'?colors.success:colors.textSecondary}}>
              {detectingShipping ? 'Reading tracking number…'
                : shipping?.status==='BOUND' ? `Tracking number read · ${shortenedTracking(shipping.trackingNumber ?? '')}`
                : shipping?.status==='QUEUED' ? 'Tracking number read · saved on this device'
                : shipping?.status==='UNAVAILABLE' ? 'Keep recording. We’ll check the label at review.'
                : shipping?.status==='CONFLICT' ? 'This label differs from the order’s tracking. Check it at review.'
                : shipping?.status==='NEEDS_CONFIRMATION' ? `Tracking number read · ${shortenedTracking(shipping.trackingNumber ?? '')} · check at review`
                : 'Show the shipping label during this recording.'}
            </Text>
            {shippingError ? <Text style={{color:colors.error}}>{shippingError}</Text> : null}
          </View> : null}
          {request.guide ? (
            <Text style={{ color: colors.textSecondary }}>
              Match the translucent outbound view where practical. The guide
              does not alter the new recording.
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: colors.error }}>
              {error} Check camera permission or close another camera app, then
              retry.
            </Text>
          ) : null}
          {coach ? <Text style={{ color: colors.textSecondary }}>
            {recipe === receivingRecipe
              ? "Keep the unopened package in view as you open it. Show the contents and their visible condition."
              : "Keep the item and package in view as you pack and seal it. Show the shipping label during the recording."}
          </Text> : null}
          {recording ? (
            <Button label="Finish recording" loading={saving} onPress={stop} />
          ) : (
            <Button
              label={request.stageType ? "Record this stage" : "Record packing"}
              disabled={!ready || saving}
              onPress={() => void start()}
            />
          )}
          <Button
            label={coach ? "Hide guidance" : "Show guidance"}
            variant="tertiary"
            onPress={() => setCoach(!coach)}
          />
          {!recording ? (
            <Button
              label="Cancel camera"
              variant="tertiary"
              onPress={() => onFinish(null)}
            />
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  heading: { padding: 16, gap: 6 },
  title: { fontSize: 19, fontWeight: "600" },
  camera: { flex: 1, minHeight: 200, backgroundColor: "#101b2b" },
  frame: {
    position: "absolute",
    top: "12%",
    left: "12%",
    width: "76%",
    height: "76%",
    borderWidth: 2,
    borderColor: "#7DE4ED",
    borderRadius: 16,
  },
  controls: { padding: 16, gap: 12 },
});
