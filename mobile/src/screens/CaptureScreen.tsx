import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { OFFLINE_CAPTURE_MESSAGE } from "../copy/errors";
import { formatDuration } from "../capture";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "../ui/Button";
import { ProgressState } from "../ui/EvidenceCard";
import { InfoCard } from "../ui/ProofCard";
import { ErrorBanner } from "../ui/EmptyState";
import { VideoReview } from "../ui/VideoReview";

export function CaptureScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const txn = app.transactionDetail ?? app.proof?.transaction;
  const preparing = app.captureStatus === "preparing";
  const uploading = app.captureStatus === "uploading";
  const securing = app.captureStatus === "uploaded";
  const committed = app.captureStatus === "committed";
  const inFlight = preparing || uploading || securing || committed;
  const belongs = app.session?.captureProofId === app.proof?.proofId;
  const reviewing = Boolean(app.localCapture) && belongs && !inFlight;

  const progressLabel = preparing
    ? "Preparing…"
    : uploading
      ? `Uploading${app.uploadPercent != null ? ` • ${app.uploadPercent}%` : ""}`
      : securing
        ? "Securing evidence…"
        : committed
          ? "Committed"
          : "";

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: Math.max(insets.top, 20),
          paddingBottom: Math.max(insets.bottom, 20),
          backgroundColor: colors.scanBackground,
        },
      ]}
    >
      <Text style={[styles.title, { color: colors.scanText }]}>
        {inFlight ? "Securing evidence…" : reviewing ? "Review your evidence" : "Capture evidence"}
      </Text>
      <Text style={[styles.prompt, { color: colors.scanMuted }]}>
        {inFlight
          ? "PackProof is uploading and committing this recording. It is not secured until the server confirms."
          : reviewing
            ? "Use this recording or retake it. It stays on this device until it is secured."
            : "Keep the item and package in frame."}
      </Text>
      {txn ? (
        <InfoCard>
          <Text style={[styles.item, { color: colors.textPrimary }]}>
            {txn.itemTitle || "Item"}
          </Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {txn.externalReference ? `Order ${txn.externalReference}` : ""}
          </Text>
        </InfoCard>
      ) : null}
      <ErrorBanner message={app.error} />
      {app.localCapture && !belongs ? (
        <Button
          label="Return to saved recording"
          onPress={() => {
            if (app.session?.captureProofId)
              void app.run(() => app.openProof(app.session!.captureProofId!));
            else app.goBack();
          }}
        />
      ) : null}
      {app.offline && app.localCapture ? (
        <Text style={[styles.note, { color: colors.scanMuted }]}>{OFFLINE_CAPTURE_MESSAGE}</Text>
      ) : null}

      {inFlight ? (
        <ProgressState
          label={progressLabel}
          percent={preparing ? 8 : uploading ? app.uploadPercent : 100}
          detail={committed ? "Evidence is now part of this Proof." : undefined}
        />
      ) : null}

      {reviewing && app.localCapture ? (
        <View style={styles.preview}>
          <VideoReview key={app.localCapture.uri} uri={app.localCapture.uri} />
          <Text style={[styles.item, { color: colors.scanText }]}>
            {formatDuration(app.localCapture.durationMs)} recording
          </Text>
          <Button
            label={app.captureStatus === "retry" ? "Try again" : "Use recording"}
            onPress={() => void app.submitCapture()}
            loading={app.busy}
            haptic="medium"
          />
          <Button
            label="Retake"
            onPress={() => void app.startCapture()}
            variant="secondary"
            disabled={app.busy}
          />
          <Button
            label="Discard"
            onPress={() => void app.discardCapture()}
            variant="tertiary"
            disabled={app.busy}
          />
        </View>
      ) : null}

      {!app.localCapture && !inFlight ? (
        <Button
          label="Start recording"
          onPress={() => void app.startCapture()}
          loading={app.busy}
          haptic="medium"
        />
      ) : null}

      <Button
        label="Back"
        onPress={app.goBack}
        variant="tertiary"
        disabled={app.busy && inFlight}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle },
  prompt: { ...typography.body },
  item: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  note: { ...typography.secondary },
  preview: { gap: spacing.md },
});
