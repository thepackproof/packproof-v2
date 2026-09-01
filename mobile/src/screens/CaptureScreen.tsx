import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { OFFLINE_CAPTURE_MESSAGE } from "../copy/errors";
import { formatDuration } from "../capture";
import { colors, spacing, typography } from "../theme/tokens";
import { Button } from "../ui/Button";
import { ProgressState } from "../ui/EvidenceCard";
import { InfoCard } from "../ui/ProofCard";

export function CaptureScreen() {
  const app = usePackProof();
  const insets = useSafeAreaInsets();
  const txn = app.transactionDetail ?? app.proof?.transaction;
  const reviewing = Boolean(app.localCapture) && app.captureStatus !== "uploading" && app.captureStatus !== "uploaded";
  const securing = app.captureStatus === "uploading" || app.captureStatus === "uploaded";

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 20) }]}>
      <Text style={styles.title}>{securing ? "Securing evidence…" : reviewing ? "Review your evidence" : "Capture evidence"}</Text>
      <Text style={styles.prompt}>
        {securing
          ? "PackProof is uploading and committing this recording. It is not secured until the server confirms."
          : reviewing
            ? "Use this recording or retake it. It stays on this device until it is secured."
            : "Keep the item and package in frame."}
      </Text>
      {txn ? (
        <InfoCard>
          <Text style={styles.item}>{txn.itemTitle || "Item"}</Text>
          <Text style={styles.meta}>{txn.externalReference ? `Order ${txn.externalReference}` : ""}</Text>
        </InfoCard>
      ) : null}
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      {app.offline && app.localCapture ? <Text style={styles.note}>{OFFLINE_CAPTURE_MESSAGE}</Text> : null}

      {app.captureStatus === "uploading" ? (
        <ProgressState label={`Uploading evidence${app.uploadPercent != null ? ` • ${app.uploadPercent}%` : ""}`} percent={app.uploadPercent} />
      ) : null}
      {app.captureStatus === "uploaded" ? <ProgressState label="Securing evidence…" percent={100} /> : null}

      {reviewing && app.localCapture ? (
        <View style={styles.preview}>
          <Text style={styles.item}>{formatDuration(app.localCapture.durationMs)} recording</Text>
          <Button label={app.captureStatus === "retry" ? "Try again" : "Use recording"} onPress={() => void app.submitCapture()} loading={app.busy} />
          <Button label="Retake" onPress={() => void app.startCapture()} variant="secondary" disabled={app.busy} />
          <Button label="Discard" onPress={() => void app.discardCapture()} variant="tertiary" disabled={app.busy} />
        </View>
      ) : null}

      {!app.localCapture && !securing ? (
        <Button label="Start recording" onPress={() => void app.startCapture()} loading={app.busy} />
      ) : null}

      <Button label="Back" onPress={app.goBack} variant="tertiary" disabled={app.busy && securing} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.scanBg, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle, color: colors.scanInk },
  prompt: { ...typography.body, color: colors.scanMuted },
  item: { ...typography.cardTitle, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: "#F5C2C2" },
  note: { ...typography.secondary, color: colors.scanMuted },
  preview: { gap: spacing.md },
});
