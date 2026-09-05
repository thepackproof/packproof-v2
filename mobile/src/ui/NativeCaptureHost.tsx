import { useEffect, useRef, useState } from "react";
import {
  AppState,
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
    [step, setStep] = useState(0),
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
        camera.current?.stopRecording();
      }
    });
    return () => listener.remove();
  }, []);
  async function start() {
    if (!camera.current || !ready || recordingRef.current) return;
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
      const video = await camera.current.recordAsync({ maxDuration: 180 });
      setSaving(true);
      if (!video?.uri)
        throw new Error(
          "The camera returned no recording. No save was confirmed.",
        );
      const durationMs = Math.max(1, Date.now() - started.current);
      onFinish({
        uri: video.uri,
        contentType: Platform.OS === "ios" ? "video/quicktime" : "video/mp4",
        byteSize: null,
        durationMs,
        bookmarks: bookmarks.current
          .filter((bookmark) => bookmark.startMs < durationMs)
          .map((bookmark) => ({
            ...bookmark,
            endMs: Math.min(bookmark.endMs, durationMs),
          })),
        interrupted: interrupted.current,
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
  function mark() {
    const startMs = Math.max(0, Date.now() - started.current);
    bookmarks.current.push({
      label: recipe[step].label,
      startMs,
      endMs: startMs + 1000,
      sourceType: "USER_MARKED",
      recipeVersion: recipe === receivingRecipe ? "packproof-native-receiving-v1" : "packproof-native-packing-v1",
    });
    setStep((value) => Math.min(recipe.length - 1, value + 1));
  }
  const stop = () => {
    if (recordingRef.current) {
      setSaving(true);
      camera.current?.stopRecording();
    }
  };
  return (
    <Modal
      visible
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={() => (recordingRef.current ? stop() : onFinish(null))}
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
              : "Ready to record"}
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
              ? `${Math.floor(elapsed / 1000)} seconds · silent video`
              : "Camera recording · up to 3 minutes · audio is not required"}
          </Text>
        </View>
        <View style={styles.camera}>
          <CameraView
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
          {coach ? (
            <View style={{ gap: 6 }}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>
                {recipe[step].label}
              </Text>
              <Text style={{ color: colors.textSecondary }}>
                {recipe[step].hint}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                Guide only. A bookmark records your selected moment; it does not
                confirm image quality or item identity.
              </Text>
              {recording ? (
                <Button
                  label={`Mark ${recipe[step].label.toLowerCase()} moment`}
                  variant="secondary"
                  disabled={saving}
                  onPress={mark}
                />
              ) : null}
            </View>
          ) : null}
          {recording ? (
            <Button label="Finish recording" loading={saving} onPress={stop} />
          ) : (
            <Button
              label="Start recording"
              disabled={!ready || saving}
              onPress={() => void start()}
            />
          )}
          <Button
            label={coach ? "Hide guidance" : "Show guidance"}
            variant="secondary"
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
