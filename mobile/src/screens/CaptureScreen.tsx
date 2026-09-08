import { nativeStudyForCapture } from "../analytics/native-study";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { OFFLINE_CAPTURE_MESSAGE } from "../copy/errors";
import { confirmCaptureShipping, formatDuration, inspectCaptureShipping, persistCaptureMetadata } from "../capture";
import { captureRecoveryLabel } from "../capture/recovery-model";
import { labelNeedsReview, shortenedTracking, type CaptureShippingReview } from "../capture/shipping-scan-queue";
import type { EncodedVideoInspection } from "../../modules/packproof-unified-camera";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { Ionicons } from "@expo/vector-icons";
import { Button, IconButton } from "../ui/Button";
import { ProgressState } from "../ui/EvidenceCard";
import { ErrorBanner } from "../ui/EmptyState";
import { VideoReview } from "../ui/VideoReview";
import { SellerAttestation } from "../ui/SellerAttestation";
import { isGradingWorkflow } from "../copy/custody";

export function CaptureScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const txn = app.transactionDetail ?? app.proof?.transaction;
  const [labels, setLabels] = useState<CaptureShippingReview | null>(null);
  const [inspection, setInspection] = useState<EncodedVideoInspection | null>(null);
  const [checkingLabel, setCheckingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const openedPreview = useRef<string | null>(null);
  const capture = app.localCapture;
  const belongs = app.session?.captureProofId === app.proof?.proofId;
  const inFlight = ["preparing", "uploading", "uploaded", "committed"].includes(app.captureStatus);
  const reviewing = Boolean(capture) && belongs && !inFlight;
  const sellerAttestation = Platform.OS === "android" && app.role === "SELLER" && !isGradingWorkflow(app.proof?.workflowType);
  const ordinaryCapture = Boolean(capture?.captureSessionId) && !capture?.captureStageId && !isGradingWorkflow(app.proof?.workflowType);

  useEffect(() => {
    if (!app.proof || capture || inFlight || app.busy || openedPreview.current === app.proof.proofId) return;
    openedPreview.current = app.proof.proofId;
    // Selection opens the preview only. Native Record packing remains intentional.
    void app.startCapture();
  }, [app.proof?.proofId, Boolean(capture), inFlight, app.busy]);

  useEffect(() => {
    if (!capture || !belongs || !ordinaryCapture || !app.proof || !capture.captureSessionId) return;
    let disposed = false;
    const selectedCapture = capture;
    const proofId = app.proof.proofId;
    setCheckingLabel(true); setLabelError(null); setLabels(null);
    void (async () => {
      // The original is already persisted and playable review remains visible during optional inspection.
      const checked = await inspectCaptureShipping(app.client, selectedCapture).catch(() => null);
      if (disposed) return;
      setInspection(checked);
      const result = await app.client.getCaptureShippingReview(proofId, selectedCapture.captureSessionId!);
      if (!disposed) setLabels(result);
    })().catch(() => {
      if (!disposed) setLabelError("Your recording is kept. Reconnect to check its label before confirming.");
    }).finally(() => { if (!disposed) setCheckingLabel(false); });
    return () => { disposed = true; };
  }, [capture?.captureSessionId, belongs, ordinaryCapture, app.client, reviewVersion]);

  useEffect(() => {
    if (!capture || !belongs || !ordinaryCapture || !capture.captureUserId) return;
    let active=true;
    void nativeStudyForCapture(app.client,capture.captureUserId,capture.studyTimingRef).then(study=>{if(active)study?.event('review_opened');});
    return()=>{active=false;};
  }, [capture?.captureSessionId, belongs, ordinaryCapture, app.client]);

  async function resolveOtherLabel(observationId: string) {
    if (!capture?.captureSessionId || !app.proof) return;
    await app.run(async () => {
      await app.client.resolveCaptureShippingObservation(app.proof!.proofId, capture.captureSessionId!, observationId, "Seller identified another package’s label in this recording.");
      if (capture.recovery) capture.recovery.authorization = undefined;
      await persistCaptureMetadata(capture);
      setReviewVersion(version => version + 1);
    });
  }

  const unresolved = labels?.observations.filter(labelNeedsReview) ?? [];
  const labelBlocked = ordinaryCapture && (checkingLabel || Boolean(labelError) || !labels || labels.reviewRequired || inspection?.playable === false);
  const progressLabel = capture?.recovery ? captureRecoveryLabel(capture.recovery.phase) : app.captureStatus === "uploading"
    ? `Uploading${app.uploadPercent != null ? ` · ${app.uploadPercent}%` : ""}` : "Finishing your Proof…";

  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={[
    styles.root, { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 20) },
  ]}>
    <AppHeader title="Proof" onBack={app.goBack} right={app.role === "SELLER" && app.proof?.proofId ? <IconButton label="Share Proof" onPress={() => void app.shareProofLink()}><Ionicons name="share-outline" size={22} color={colors.textPrimary} /></IconButton> : undefined} />
    <Text style={[styles.title, { color: colors.textPrimary }]}>{inFlight ? "Finishing your Proof" : reviewing ? "Review your recording" : "Ready to pack"}</Text>
    {txn ? <View style={{ gap: spacing.xs }}>
      <Text style={[styles.item, { color: colors.textPrimary }]}>{txn.itemTitle || "Your shipment"}</Text>
      {txn.externalReference ? <Text style={[styles.note, { color: colors.textSecondary }]}>Order {txn.externalReference}</Text> : null}
    </View> : null}
    <ErrorBanner message={app.error} />
    {capture && !belongs ? <Button label="Return to saved recording" onPress={() => {
      if (app.session?.captureProofId) void app.run(() => app.openProof(app.session!.captureProofId!)); else app.goBack();
    }} /> : null}
    {app.offline && capture ? <Text style={[styles.note, { color: colors.textSecondary }]}>{OFFLINE_CAPTURE_MESSAGE}</Text> : null}
    {inFlight ? <ProgressState label={progressLabel} percent={app.captureStatus === "uploading" ? app.uploadPercent : null} /> : null}
    {reviewing && capture ? <View style={styles.preview}>
      <VideoReview key={capture.uri} uri={capture.uri} />
      <Text style={[styles.note, { color: colors.textSecondary }]}>
        {formatDuration(capture.durationMs)} recording{capture.interrupted ? " · interrupted recording" : ""}
      </Text>
      {capture.interrupted ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.textSecondary }]}>
        Recording was interrupted. Review the saved video; it is preserved as this take and is never joined to another recording.
      </Text> : null}
      {ordinaryCapture ? <View style={styles.labelReview} accessibilityLiveRegion="polite">
        <Text style={[styles.item, { color: colors.textPrimary }]}>Shipping label</Text>
        <Text style={[styles.note, { color: colors.textSecondary }]}>{checkingLabel ? "Checking the label in your saved video…"
          : labelError ?? (inspection?.playable === false ? "This recording could not be played. Its bytes are kept for review."
          : unresolved.length ? "Check the label below before confirming your shipment."
          : labels?.currentTrackingNumber ? `Tracking ${shortenedTracking(labels.currentTrackingNumber)}`
          : "We couldn’t read a shipping label in this recording. You can submit it without tracking.")}</Text>
        {labelError ? <Button label="Check again" variant="secondary" onPress={() => setReviewVersion(version => version + 1)} /> : null}
        {unresolved.map(observation => {
          const mismatch = Boolean(labels?.currentTrackingNumber && labels.currentTrackingNumber !== observation.trackingNumber);
          return <View key={observation.observationId} style={[styles.observation, { borderColor: colors.border }]}>
            <Text style={[styles.note, { color: colors.textPrimary }]}>{observation.trackingNumber}</Text>
            <Text style={[styles.note, { color: colors.textSecondary }]}>{mismatch ? "This label differs from the order’s tracking. Check which package is being shipped." : "Is this the shipping label for this package?"}</Text>
            {!mismatch ? <Button label="Use this tracking number" variant="secondary" disabled={app.busy} onPress={() => void app.run(async () => {
              await confirmCaptureShipping(app.client, capture, observation.observationId); setReviewVersion(version => version + 1);
            })} /> : null}
            <Button label="This is another package’s label" variant="tertiary" disabled={app.busy} onPress={() => Alert.alert(
              "Identify another package’s label?", "The observed label stays in this Proof with your explanation. The selected order and its tracking stay attached to this recording.", [
                { text: "Keep reviewing", style: "cancel" }, { text: "Identify other label", onPress: () => void resolveOtherLabel(observation.observationId) },
              ])} />
          </View>;
        })}
        {inspection?.frames.length ? <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}>
          {inspection.frames.map(frame => <View key={frame.uri} style={{ width: 136, gap: spacing.xs }}>
            <Image source={{ uri: frame.uri }} resizeMode="contain" style={{ width: 136, height: 86, backgroundColor: colors.surface }} accessibilityLabel={`Video frame near ${Math.round(frame.requestedOffsetMs / 1000)} seconds`} />
            <Text style={[styles.note, { color: colors.textSecondary }]}>Video frame · near {Math.round(frame.requestedOffsetMs / 1000)}s</Text>
          </View>)}
        </ScrollView> : null}
      </View> : null}
      {sellerAttestation ? <SellerAttestation onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked} />
        : <Button label={app.captureStatus === "retry" ? "Try again" : "Use recording"} onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked} haptic="medium" />}
      <Text style={[styles.note, { color: colors.textSecondary }]}>{capture.recovery ? captureRecoveryLabel(capture.recovery.phase) : "Saved on this device. Upload pending."}</Text>
      <Button label="Retake recording" onPress={() => Alert.alert("Record a new take?", "Keep the item and package in view for the entire new recording.", [
        { text: "Keep this recording", style: "cancel" }, { text: "Open camera", onPress: () => void app.startCapture() },
      ])} variant="secondary" disabled={app.busy || Boolean(capture.uploadEvidenceId)} />
      {sellerAttestation && /biometric|fingerprint|enroll|lock/i.test(app.error ?? "") ? <Button label="Open biometric settings"
        onPress={() => void Linking.sendIntent("android.settings.BIOMETRIC_ENROLL").catch(() => Linking.openSettings())} variant="tertiary" disabled={app.busy} /> : null}
      <Button label="Discard recording" onPress={() => Alert.alert("Discard this local recording?", "This removes the recording from this device. An unpreserved recording cannot be recovered. Existing committed server evidence stays in the Proof.", [
        { text: "Keep recording", style: "cancel" }, { text: "Discard local copy", style: "destructive", onPress: () => void app.discardCapture() },
      ])} variant="tertiary" disabled={app.busy} />
    </View> : null}
    {!capture && !inFlight ? <Button label="Open camera" onPress={() => void app.startCapture()} loading={app.busy} /> : null}
    <Button label="Back" onPress={app.goBack} variant="tertiary" disabled={app.busy} />
  </ScrollView>;
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { ...typography.pageTitle }, item: { ...typography.cardTitle }, note: { ...typography.secondary },
  preview: { gap: spacing.md }, labelReview: { gap: spacing.sm },
  observation: { borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: spacing.sm },
});
