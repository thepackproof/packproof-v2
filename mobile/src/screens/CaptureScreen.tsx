import {SIGNAL_ENABLED} from "../experience/signal";
import {SignalText,SignalSteps,SignalGuide,SignalBadge} from "../ui/Signal";
import {BottomSheet} from "../ui/Sheets";
import { requiresRecordingRecovery } from '../capture/recording-review';
import { nativeStudyForCapture } from "../analytics/native-study";
import { researchProductionEnabled } from '../research/isolation';
import { ReceiptConsent } from '../research/ReceiptConsent';
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { IdentifierReview } from '../../../backend/src/identifiers/types';
import { captureIdentifiers, identifierFailureBlocks, readIdentifierReview } from '../capture/identifier-storage';
import { identifierCaptureEnabled } from '../capture/identifier-observation';
import { newIdempotencyKey } from '../v2-api';
import { IdentifierDetails } from '../ui/IdentifierDetails';
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePackProof } from "../app/PackProofProvider";
import { OFFLINE_CAPTURE_MESSAGE } from "../copy/errors";
import { confirmCaptureShipping, formatDuration, inspectCaptureShipping, persistCaptureMetadata } from "../capture";
import { captureRecoveryLabel } from "../capture/recovery-model";
import { captureProgressLabel } from "../capture/upload-recovery";
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
import { RemainingShipmentNotice } from "../ui/RemainingShipmentNotice";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";
import { manualReviewBinding } from "../experience/manual-review";
import { ManualReviewConfirmation } from "../ui/ManualReviewConfirmation";

const TASK_UI = SIGNAL_ENABLED || ANDROID_TASK_FIRST_REBUILD;

export function CaptureScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const txn = app.transactionDetail ?? app.proof?.transaction;
  const [retakeOpen,setRetakeOpen]=useState(false);
  const [labels, setLabels] = useState<CaptureShippingReview | null>(null);
  const [inspection, setInspection] = useState<EncodedVideoInspection | null>(null);
  const [checkingLabel, setCheckingLabel] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [identifiers, setIdentifiers] = useState<IdentifierReview | null>(null);
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [identifierBlocked, setIdentifierBlocked] = useState(false);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [showLabelDetails, setShowLabelDetails] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showRecordingOptions, setShowRecordingOptions] = useState(false);
  const [inspectSurviving, setInspectSurviving] = useState(false);
  const openedPreview = useRef<string | null>(null);
  const capture = app.localCapture;
  const reviewOnly=Boolean(app.captureReviewOnlyReason);
  const belongs = app.session?.captureProofId === (app.proof?.proofId??capture?.captureProofId);
  const inFlight = ["preparing", "uploading", "uploaded", "committed"].includes(app.captureStatus);
  const incomplete = requiresRecordingRecovery(capture);
  const reviewing = Boolean(capture) && belongs && !inFlight && !incomplete;
  const sellerAttestation = (Platform.OS === "android" || Platform.OS === "ios") && app.role === "SELLER" && !isGradingWorkflow(app.proof?.workflowType);
  const ordinaryCapture = Boolean(capture?.captureSessionId) && !capture?.captureStageId && !isGradingWorkflow(app.proof?.workflowType);

  useEffect(() => {
    if (SIGNAL_ENABLED || (researchProductionEnabled() && (!TASK_UI || isGradingWorkflow(app.proof?.workflowType))) || reviewOnly || !app.proof || capture || inFlight || app.busy || openedPreview.current === app.proof.proofId) return;
    openedPreview.current = app.proof.proofId;
    // Selection opens the preview only. Native Record packing remains intentional.
    void app.startCapture();
  }, [app.proof?.proofId, Boolean(capture), inFlight, app.busy]);

  useEffect(() => {
    if (reviewOnly || !capture || !belongs || incomplete || !ordinaryCapture || !app.proof || !capture.captureSessionId) return;
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
  }, [capture?.captureSessionId, belongs, incomplete, ordinaryCapture, app.client, reviewVersion,reviewOnly]);

  useEffect(() => {
    setIdentifiers(null); setIdentifierError(null); setIdentifierBlocked(false); setReviewReasons({});
    if (reviewOnly || !capture || !belongs || incomplete || !identifierCaptureEnabled(capture.identifierPolicy)) return;
    let disposed = false;
    void (async () => {
      // Share the already-running local inspection; no second video pass.
      await inspectCaptureShipping(app.client, capture).catch(() => null);
      const result = await readIdentifierReview(app.client, capture);
      if (!disposed) setIdentifiers(result);
    })().catch(error => {
      if (disposed) return;
      const blocked = identifierFailureBlocks(error);
      setIdentifierBlocked(blocked);
      setIdentifierError(blocked ? 'Reconnect in this recording’s original account to check its saved code review.' : 'Code details are unavailable. Your recording can still be submitted.');
    });
    return () => { disposed = true; };
  }, [capture?.captureSessionId, belongs, incomplete, app.client, reviewVersion,reviewOnly]);

  useEffect(() => {
    if (reviewOnly || !capture || !belongs || !ordinaryCapture || !capture.captureUserId) return;
    let active=true;
    void nativeStudyForCapture(app.client,capture.captureUserId,capture.studyTimingRef,capture.captureStageId?undefined:capture.captureProofId).then(study=>{if(active)study?.event('review_opened');});
    return()=>{active=false;};
  }, [capture?.captureSessionId, belongs, ordinaryCapture, app.client,reviewOnly]);

  async function resolveOtherLabel(observationId: string) {
    if (!capture?.captureSessionId || !app.proof) return;
    await app.run(async () => {
      await app.client.resolveCaptureShippingObservation(app.proof!.proofId, capture.captureSessionId!, observationId, "Seller identified another package’s label in this recording.");
      if (capture.recovery) capture.recovery.authorization = undefined;
      await persistCaptureMetadata(capture);
      setReviewVersion(version => version + 1);
    });
  }

  async function decideIdentifier(observationId: string, decision: 'NOT_THIS_SHIPMENT' | 'ACKNOWLEDGE_MISMATCH') {
    if (!capture?.captureSessionId || !capture.captureProofId || !identifiers) return;
    const reason = reviewReasons[observationId]?.trim() || (decision === 'NOT_THIS_SHIPMENT' ? 'Seller identified a code belonging to an item outside this shipment.' : '');
    if (reason.length < 5) return;
    await app.run(async () => {
      const handle = await captureIdentifiers(app.client, capture);
      handle?.assertScope();
      const review = await app.client.decideCaptureIdentifier(capture.captureProofId!, capture.captureSessionId!, {
        clientEventId: newIdempotencyKey(), observationId, revision: identifiers.revision, decision, reason,
      });
      handle?.assertScope();
      await handle?.journal.updateReview(review);
      if (capture.recovery) capture.recovery.authorization = undefined;
      capture.identifierCheckpoint = undefined; capture.identifierCheckpointRequest = undefined;
      await persistCaptureMetadata(capture);
      setIdentifiers(review); setIdentifierBlocked(false);
    });
  }

  const unresolved = labels?.observations.filter(labelNeedsReview) ?? [];
  const labelBlocked = capture?.replacement?.decision === "pending" || (ordinaryCapture && (checkingLabel || Boolean(labelError) || !labels || labels.reviewRequired || inspection?.playable === false)) || identifierBlocked || identifiers?.reviewRequired === true;
  const progressLabel = captureProgressLabel(app.captureStatus, app.uploadPercent);
  const title = incomplete ? "Interrupted recording" : inFlight ? "Saving your evidence" : reviewing ? (TASK_UI ? "Review your recording" : "Review recording") : "Ready to pack";
  const confirmationBinding = manualReviewBinding({
    proofId: app.proof?.proofId ?? "", originalId: `${capture?.captureSessionId ?? ""}:${capture?.uri ?? ""}:${capture?.captureSha256 ?? ""}`,
    accountId: app.session?.userId ?? "", apiBaseUrl: app.client.apiBaseUrl,
    metadata: { transaction: txn, tracking: labels?.currentTrackingNumber, identifiersRevision: identifiers?.revision },
    reviewRevision: reviewVersion,
  });
  function discardRecording() {
    Alert.alert("Discard this local recording?", "This removes this take from this device after PackProof closes its incomplete upload. It cannot be recovered. Existing committed server evidence stays in the Proof.", [
      { text: "Keep recording", style: "cancel" }, { text: "Discard local copy", style: "destructive", onPress: () => void app.discardCapture() },
    ]);
  }


  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={[
    styles.root, { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 16) },
  ]}>
    <AppHeader title={SIGNAL_ENABLED ? txn?.itemTitle || "Packing record" : title} onBack={() => { if (!app.busy) app.goBack(); }} right={!TASK_UI && !reviewOnly && app.role === "SELLER" && app.proof?.proofId ? <IconButton label="Share Proof" disabled={app.busy} onPress={() => void app.shareProofLink()}><Ionicons name="share-outline" size={22} color={colors.textPrimary} /></IconButton> : undefined} />
    {!SIGNAL_ENABLED && txn ? <View style={{ gap: spacing.xs }}>
      <Text style={[styles.item, { color: colors.textPrimary }]}>{txn.itemTitle || "Your shipment"}</Text>
      {txn.externalReference ? <Text style={[styles.note, { color: colors.textSecondary }]}>Order {txn.externalReference}</Text> : null}
      <RemainingShipmentNotice value={app.proof} />
    </View> : null}
    {SIGNAL_ENABLED && !incomplete && <SignalSteps step={inFlight?3:capture?2:1}/>}
    {SIGNAL_ENABLED && reviewing && <SignalText kind="title">Review your take.</SignalText>}
    {SIGNAL_ENABLED && incomplete && <><SignalBadge>Recording interrupted</SignalBadge><SignalText kind="title">Your take{'\n'}is still here.</SignalText><SignalText muted>It ended early. Any surviving footage stays on this device.</SignalText></>}
    <ErrorBanner message={app.error} />
    {researchProductionEnabled() && app.proof && app.session && !capture && !inFlight && !reviewOnly && !isGradingWorkflow(app.proof.workflowType) ? <>
      {TASK_UI ? <Button label={showReceipt ? "Hide optional capture receipt" : "Optional capture receipt"} variant="tertiary" disabled={receiptBusy} onPress={() => setShowReceipt(!showReceipt)} /> : null}
      {!TASK_UI || showReceipt ? <ReceiptConsent key={`${app.client.apiBaseUrl}:${app.session.userId}:${app.proof.proofId}`} onBusy={setReceiptBusy} /> : null}
    </> : null}
    {capture && !belongs ? <Button label="Return to saved recording" onPress={() => {
      if (app.session?.captureProofId) void app.run(() => app.openProof(app.session!.captureProofId!)); else app.goBack();
    }} /> : null}
    {app.offline && capture ? <Text accessibilityLiveRegion={TASK_UI ? "polite" : undefined} style={[styles.note, { color: colors.textSecondary }]}>{TASK_UI && reviewing ? "Your recording is saved here. Review it now; reconnect to securely confirm and submit." : OFFLINE_CAPTURE_MESSAGE}</Text> : null}
    {inFlight ? <ProgressState label={progressLabel} percent={app.captureStatus === "uploading" && (app.uploadPercent ?? 0) < 100 ? app.uploadPercent : null} /> : null}
    {incomplete && capture && belongs ? <View style={styles.preview}>
      <Text accessibilityRole="alert" style={[styles.note, { color: colors.textSecondary }]}>{capture.localFileAvailable === false
        ? "The original recording is not available on this device. Check the device used to record, or discard the incomplete upload before recording again."
        : "This recording was interrupted before a playable video was confirmed. Any surviving bytes stay on this device. This take cannot be submitted as a completed continuous recording."}</Text>
      {capture.localFileAvailable !== false ? <>
        <Button label={inspectSurviving ? "Hide surviving video" : "Inspect surviving video"} variant="secondary" onPress={() => setInspectSurviving(!inspectSurviving)} />
        {inspectSurviving ? <VideoReview key={capture.uri} uri={capture.uri} inspection accessibilityLabel="Surviving interrupted recording. Inspect only; this is not accepted continuous packing evidence." /> : null}
        <Text style={[styles.note, { color: colors.textSecondary }]}>Playback depends on the surviving file. A playable clip does not establish a complete packing sequence.</Text>
      </> : null}
      <Button label="Keep draft and return" variant="secondary" onPress={app.goBack} disabled={app.busy} />
      {capture.replacement?.decision==='pending' && <Button label="Keep previous take" variant="secondary" onPress={()=>void app.chooseCaptureTake('original')} disabled={app.busy}/>}
      <Button label="Discard incomplete recording" onPress={discardRecording} disabled={app.busy} variant="destructive" />
      <Text style={[styles.note, { color: colors.textSecondary }]}>After discarding, open the camera to record a new continuous take. Saved segments are never joined together.</Text>
    </View> : null}
    {reviewing && capture ? <View style={styles.preview}>
      <VideoReview key={capture.uri} uri={capture.uri} compact />
      {TASK_UI ? <Text style={[styles.note, { color: colors.textSecondary }]}>
        {formatDuration(capture.durationMs)} · {capture.recovery?.phase === "LOCAL_ONLY" || (!capture.recovery && !capture.uploadEvidenceId)
          ? "Recording saved on this device. Not uploaded yet."
          : capture.recovery ? captureRecoveryLabel(capture.recovery.phase) : "Saved on this device. Upload pending."}
      </Text> : null}
      {capture.researchNotice ? <Text style={[styles.note, { color: colors.textSecondary }]}>{capture.research?.unavailableReason ?? capture.researchNotice}</Text> : null}
      {reviewOnly ? <><Text accessibilityRole="alert" style={[styles.note,{color:colors.textSecondary}]}>{app.captureReviewOnlyReason}</Text><Button label="Check current Proof" onPress={()=>void app.resumeSavedCapture(capture)} disabled={app.busy||app.offline} variant="secondary" /></> : null}
      {!TASK_UI && !reviewOnly && labelBlocked ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: colors.textSecondary }]}>{checkingLabel
        ? "Checking required recording details before confirmation…"
        : "Resolve the recording checks below before confirming. Your local original is kept."}</Text> : null}
      {!TASK_UI && !reviewOnly ? (sellerAttestation ? <SellerAttestation compact onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked} />
        : <Button label={app.captureStatus === "retry" ? "Try again" : "Use recording"} onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked} haptic="medium" />) : null}
      {!TASK_UI ? <Text style={[styles.note, { color: colors.textSecondary }]}>
        {formatDuration(capture.durationMs)} recording{capture.interrupted ? " · interrupted recording" : ""}
      </Text> : null}
      {capture.interrupted ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.textSecondary }]}>
        Recording was interrupted. Review the saved video; it is preserved as this take and is never joined to another recording.
      </Text> : null}
      {!reviewOnly && ordinaryCapture ? <View style={styles.labelReview} accessibilityLiveRegion="polite">
        <Text style={[styles.item, { color: colors.textPrimary }]}>Shipping label</Text>
        <Text style={[styles.note, { color: colors.textSecondary }]}>{checkingLabel ? "Checking the label in your saved video…"
          : labelError ?? (inspection?.playable === false ? "This recording could not be played. Its bytes are kept for review."
          : unresolved.length ? "Check the label below before confirming your shipment."
          : labels?.currentTrackingNumber ? `Tracking ${shortenedTracking(labels.currentTrackingNumber)}`
          : "No shipping label detected. You can still submit this Proof without tracking.")}</Text>
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
        {TASK_UI && inspection?.frames.length ? <Button label={showLabelDetails ? "Hide label frames" : "View label frames"} variant="tertiary" onPress={() => setShowLabelDetails(!showLabelDetails)} /> : null}
        {inspection?.frames.length && (!TASK_UI || showLabelDetails) ? <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}>
          {inspection.frames.map(frame => <View key={frame.uri} style={{ width: 136, gap: spacing.xs }}>
            <Image source={{ uri: frame.uri }} resizeMode="contain" style={{ width: 136, height: 86, backgroundColor: colors.surface }} accessibilityLabel={`Video frame near ${Math.round(frame.requestedOffsetMs / 1000)} seconds`} />
            <Text style={[styles.note, { color: colors.textSecondary }]}>Video frame · near {Math.round(frame.requestedOffsetMs / 1000)}s</Text>
          </View>)}
        </ScrollView> : null}
      </View> : null}
      {!reviewOnly && identifierCaptureEnabled(capture.identifierPolicy) ? <View style={styles.labelReview}>
        {identifierError ? <Text style={[styles.note, { color: colors.textSecondary }]}>{identifierError}</Text> : null}
        {identifierError ? <Button label="Check codes again" variant="tertiary" onPress={() => setReviewVersion(version => version + 1)} /> : null}
        {(identifiers?.observations ?? []).filter(row => row.reviewRequired && !row.decision).map(row => <View key={row.observationId} style={[styles.observation, { borderColor: colors.border }]}>
          <Text style={[styles.item, { color: colors.textPrimary }]}>Check this item code</Text>
          <Text style={[styles.note, { color: colors.textSecondary }]}>This code does not match the selected order. Check the video and package before confirming.</Text>
          <Text selectable style={[styles.note, { color: colors.textPrimary }]}>{row.product?.title ?? row.identifiers.map(item => `${item.type} ${item.normalizedValue ?? item.value}`).join(' · ')}</Text>
          {row.expected.length ? <Text style={[styles.note, { color: colors.textSecondary }]}>Expected: {row.expected.map(item => item.title).join('; ')}</Text> : null}
          <TextInput accessibilityLabel="Reason for acknowledging the code mismatch" placeholder="Explain this mismatch if the item is being shipped" placeholderTextColor={colors.textSecondary} value={reviewReasons[row.observationId] ?? ''}
            onChangeText={reason => setReviewReasons(previous => ({ ...previous, [row.observationId]: reason }))} maxLength={500} multiline
            style={{ color: colors.textPrimary, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 60 }} />
          <Button label="Acknowledge this mismatch" variant="secondary" disabled={app.busy || (reviewReasons[row.observationId]?.trim().length ?? 0) < 5} onPress={() => void decideIdentifier(row.observationId, 'ACKNOWLEDGE_MISMATCH')} />
          <Button label="This code is not part of this shipment" variant="tertiary" disabled={app.busy} onPress={() => void decideIdentifier(row.observationId, 'NOT_THIS_SHIPMENT')} />
        </View>)}
        <IdentifierDetails value={identifiers} />
      </View> : null}
      {!TASK_UI ? <Text style={[styles.note, { color: colors.textSecondary }]}>{capture.recovery ? captureRecoveryLabel(capture.recovery.phase) : "Saved on this device. Upload pending."}</Text> : null}
      {(SIGNAL_ENABLED || TASK_UI) && !reviewOnly ? (sellerAttestation
        ? <ManualReviewConfirmation key={confirmationBinding} binding={confirmationBinding} onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked || app.offline} />
        : <Button label={app.captureStatus === "retry" ? "Try again" : "Use recording"} onPress={() => void app.submitCapture()} loading={app.busy} disabled={labelBlocked} haptic="medium" />) : null}
      {capture.replacement?.decision==='pending' && <View style={{gap:12}}><SignalText kind="heading">Choose your take</SignalText><SignalText kind="small" muted>Your previous take is still saved. Review this complete recording before choosing.</SignalText><Button label="Use this take" disabled={app.busy || capture.interrupted || inspection?.playable===false} onPress={()=>void app.chooseCaptureTake('replacement')}/><Button label="Keep previous take" variant="secondary" disabled={app.busy} onPress={()=>void app.chooseCaptureTake('original')}/></View>}
      {!reviewOnly && capture.replacement?.decision!=='pending' ? <Button label="Record another take" onPress={()=>setRetakeOpen(true)} variant="tertiary" disabled={app.busy || Boolean(capture.uploadEvidenceId) || capture.recovery?.submitRequested} /> : null}
      {sellerAttestation && /biometric|fingerprint|enroll|lock/i.test(app.error ?? "") ? <Button label="Open biometric settings"
        onPress={() => void (Platform.OS === "android" ? Linking.sendIntent("android.settings.BIOMETRIC_ENROLL").catch(() => Linking.openSettings()) : Linking.openSettings())} variant="tertiary" disabled={app.busy} /> : null}
      {!reviewOnly && TASK_UI ? <Button label={showRecordingOptions ? "Hide recording options" : "Recording options"} variant="tertiary" onPress={() => setShowRecordingOptions(!showRecordingOptions)} /> : null}
      {!reviewOnly && (!TASK_UI || showRecordingOptions) ? <Button label="Discard recording" onPress={discardRecording} variant="tertiary" disabled={app.busy} /> : null}
    </View> : null}
    {!capture && !inFlight ? SIGNAL_ENABLED ? <SignalGuide onStart={()=>void app.startCapture({autoStart:true})} busy={app.busy} disabled={receiptBusy || app.offline}/> : <Button label="Open camera" onPress={() => void app.startCapture()} loading={app.busy} disabled={receiptBusy} /> : null}
    {!capture && /camera permission|permission denied/i.test(app.error ?? "") ? <Button label="Open camera settings" variant="secondary" disabled={app.busy} onPress={() => void Linking.openSettings()} /> : null}
    {!TASK_UI ? <Button label="Back" onPress={app.goBack} variant="tertiary" disabled={app.busy} /> : null}
    <BottomSheet visible={retakeOpen} title="Record another take?" onClose={()=>setRetakeOpen(false)}><View style={{gap:20}}><SignalText muted>Your current take will stay saved on this device. After recording, choose which take to keep.</SignalText><Button label="Record another take" onPress={()=>{setRetakeOpen(false);if(capture)void app.startCapture({replaceUri:capture.uri,autoStart:true});}}/><Button label="Keep reviewing" variant="secondary" onPress={()=>setRetakeOpen(false)}/></View></BottomSheet>
  </ScrollView>;
}
const styles = StyleSheet.create({
  root: { flexGrow: 1, paddingHorizontal: SIGNAL_ENABLED?24:16, gap: SIGNAL_ENABLED?24:12 },
  title: { ...typography.pageTitle }, item: { ...typography.cardTitle }, note: { ...typography.secondary },
  preview: { gap: spacing.md }, labelReview: { gap: spacing.sm },
  observation: { borderWidth: 1, borderRadius: 12, padding: spacing.md, gap: spacing.sm },
});
