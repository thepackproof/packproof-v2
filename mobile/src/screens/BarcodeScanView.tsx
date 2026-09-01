import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { STATION_BARCODE_TYPES, normalizeStationReference } from "../packing-station/scan";

export function BarcodeScanView(props: {
  prompt?: string;
  lockKey?: string;
  onDecoded: (value: string) => void;
  onCancel: () => void;
  onPermissionDenied: () => void;
  onUnavailable: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const locked = useRef(false);
  const denied = useRef(false);
  const onPermissionDenied = useRef(props.onPermissionDenied);
  const onUnavailable = useRef(props.onUnavailable);
  onPermissionDenied.current = props.onPermissionDenied;
  onUnavailable.current = props.onUnavailable;

  useEffect(() => {
    locked.current = false;
  }, [props.lockKey]);

  useEffect(() => {
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
        <Text style={styles.copy}>Allow camera access to scan a shipping label or order barcode.</Text>
        <Pressable style={styles.button} onPress={props.onCancel}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: [...STATION_BARCODE_TYPES] }}
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
      <View style={styles.frame} pointerEvents="none" />
      <Text style={styles.copy}>{props.prompt ?? "Scan the shipping label or order barcode."}</Text>
      <Pressable style={styles.button} onPress={props.onCancel}>
        <Text style={styles.buttonText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
    wrap: { gap: 14, width: "100%", position: "relative" },
  camera: { width: "100%", aspectRatio: 3 / 4, backgroundColor: "#000" },
  frame: {
    position: "absolute",
    top: 48,
    left: 24,
    right: 24,
    height: 180,
    borderWidth: 3,
    borderColor: "#fff",
  },
  fallback: { gap: 14 },
  copy: { color: "#f4f4f4", fontSize: 18, lineHeight: 26 },
  button: { borderWidth: 2, borderColor: "#fff", paddingVertical: 16 },
  buttonText: { color: "#fff", textAlign: "center", fontSize: 18, fontWeight: "800" },
});
