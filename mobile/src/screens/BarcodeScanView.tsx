import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { STATION_BARCODE_TYPES, normalizeStationReference } from "../packing-station/scan";
import { useTheme } from "../theme/ThemeProvider";
import { PulseOpacity } from "../ui/motion";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";
import { taskFirstTypography } from "../theme/tokens";

export function BarcodeScanView(props: {
  prompt?: string;
  lockKey?: string;
  onDecoded: (value: string) => void;
  onCancel: () => void;
  onPermissionDenied: () => void;
  onUnavailable: () => void;
}) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const locked = useRef(false);
  const denied = useRef(false);
  const permissionRequested = useRef(false);
  const mounted = useRef(true);
  const foreground = ANDROID_TASK_FIRST_REBUILD ? colors.textPrimary : colors.scanText;
  const onPermissionDenied = useRef(props.onPermissionDenied);
  const onUnavailable = useRef(props.onUnavailable);
  onPermissionDenied.current = props.onPermissionDenied;
  onUnavailable.current = props.onUnavailable;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    locked.current = false;
  }, [props.lockKey]);

  useEffect(() => {
    if (ANDROID_TASK_FIRST_REBUILD) {
      if (permission?.granted || denied.current || permissionRequested.current) return;
      if (permission && !permission.canAskAgain) {
        denied.current = true;
        onPermissionDenied.current();
        return;
      }
      // One prompt per explicit scanner entry. A denial immediately exposes the
      // manual fallback; rerenders must never prompt repeatedly.
      permissionRequested.current = true;
      void requestPermission().then(result => {
        if (mounted.current && !result.granted) { denied.current = true; onPermissionDenied.current(); }
      }).catch(() => { if (mounted.current) onUnavailable.current(); });
      return;
    }
    if (!permission) {
      void requestPermission().catch(() => {
        onUnavailable.current();
      });
      return;
    }
    if (permission.granted || denied.current) {
      return;
    }
    if (permission.canAskAgain) {
      void requestPermission();
      return;
    }
    denied.current = true;
    onPermissionDenied.current();
  }, [permission, requestPermission]);

  if (!permission?.granted) {
    return (
      <View style={styles.fallback}>
        <Text style={[styles.copy, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.body, { color: foreground }]}>
          Allow camera access to scan a shipping label or order barcode.
        </Text>
        <Pressable
          style={[styles.button, { borderColor: foreground }]}
          onPress={props.onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={[styles.buttonText, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.button, { color: foreground }]}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.cameraWrap}>
        <CameraView
          style={[styles.camera, ANDROID_TASK_FIRST_REBUILD && styles.taskCamera]}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: [...STATION_BARCODE_TYPES] }}
          onMountError={ANDROID_TASK_FIRST_REBUILD ? () => { if (!locked.current) { locked.current = true; onUnavailable.current(); } } : undefined}
          onBarcodeScanned={({ data }) => {
            if (locked.current) {
              return;
            }
            const value = normalizeStationReference(data);
            if (!value) {
              return;
            }
            locked.current = true;
            props.onDecoded(value);
          }}
        />
        {ANDROID_TASK_FIRST_REBUILD ? <View pointerEvents="none" accessible={false} style={[styles.frame, styles.taskFrame, { borderColor: colors.accent }]} />
          : <PulseOpacity active style={[styles.frame, { borderColor: colors.accent }]} />}
      </View>
      {props.prompt ? <Text style={[styles.copy, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.secondary, { color: foreground }]}>{props.prompt}</Text> : null}
      <Pressable
        style={[styles.button, { borderColor: foreground }]}
        onPress={props.onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
      >
        <Text style={[styles.buttonText, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.button, { color: foreground }]}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14, width: "100%" },
  cameraWrap: { width: "100%", position: "relative" },
  camera: { width: "100%", aspectRatio: 3 / 4, backgroundColor: "#000", borderRadius: 16, overflow: "hidden" },
  taskCamera: { height: 225, aspectRatio: undefined },
  taskFrame: { top: "20%", height: "60%" },
  frame: {
    position: "absolute",
    top: 48,
    left: 24,
    right: 24,
    height: 180,
    borderWidth: 3,
    borderRadius: 12,
  },
  fallback: { gap: 14 },
  copy: { fontSize: 18, lineHeight: 26 },
  button: { borderWidth: 2, paddingVertical: 16, borderRadius: 12, minHeight: 48, justifyContent: "center" },
  buttonText: { textAlign: "center", fontSize: 18, fontWeight: "800" },
});
