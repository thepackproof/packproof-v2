import { Alert, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { captureCompletionActive } from "../capture/completion";
import { uploadRecoveryPresentation } from "../capture/upload-recovery";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";
import { ProgressState } from "./EvidenceCard";
import { StatusBadge, statusTone } from "./StatusBadge";
import { radii, spacing, typography } from "../theme/tokens";

/** Recovery stays on the recording card; the provider owns the durable work. */
export function UploadRecoveryCards() {
  const app = usePackProof(), { colors } = useTheme(), proof = app.proof!;
  const saved = new Map(app.savedRecordings.filter(item => item.captureProofId === proof.proofId).map(item => [item.recovery?.operationId ?? item.uri, item]));
  if (app.localCapture?.captureProofId === proof.proofId) {
    const key = app.localCapture.recovery?.operationId ?? app.localCapture.uri;
    saved.set(key, {...app.localCapture, localFileAvailable: saved.get(key)?.localFileAvailable ?? app.localCapture.localFileAvailable});
  }
  const local = [...saved.values()].filter(item => !["FINALIZED", "SUBMITTED"].includes(item.recovery?.phase ?? ""));
  const orphaned = proof.evidence.filter(item => item.validationStatus === "PENDING" && item.submittedBy === app.session?.userId && !local.some(capture => capture.uploadEvidenceId === item.evidenceId));
  const rows = [
    ...local.map(capture => ({ key: capture.recovery?.operationId ?? capture.uri, capture, evidenceId: capture.uploadEvidenceId })),
    ...orphaned.map(item => ({ key: item.evidenceId, capture: undefined, evidenceId: item.evidenceId })),
  ];
  rows.sort((left, right) => left.key.localeCompare(right.key));
  return <>{rows.map(({key, capture, evidenceId}) => {
    const committed = proof.evidence.some(item => item.evidenceId === evidenceId && item.validationStatus === "COMMITTED") || !!proof.commerceStages?.some(stage => stage.evidence.some(item => item.evidenceId === evidenceId && item.committedAt));
    const state = capture?.recovery;
    const live = !!state && captureCompletionActive(state.operationId) && state.phase === "UPLOADING";
    const saving = !!state && ['BYTES_RECEIVED','PRESERVATION_PENDING','FINALIZATION_PENDING'].includes(state.phase) && !state.lastError;
    const view = uploadRecoveryPresentation({ available: capture ? capture.localFileAvailable ?? null : false, active: live, offline: app.offline,
      queued: state?.phase === 'UPLOAD_QUEUED' && state.completionNotificationRequested && !state.lastError,
      saving,
      committed, accepted: state?.submitRequested, failed: state?.lastError?.retryable === false, discarding: state?.discardRequested });
    const discard = () => Alert.alert(view.discard!, "Close this incomplete upload and remove its local recording? Committed evidence is protected.", [
      { text: "Keep recording", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => { if (capture) void app.discardSavedCapture(capture); else if (evidenceId) void app.discardIncompleteEvidence(evidenceId); } },
    ]);
    const label = view.title === "Uploading" ? "Uploading recording" : view.title === "Saving Proof" ? "Finalizing Proof" : view.title;
    return <View key={key} style={[styles.card, {backgroundColor: colors.surface, borderColor: colors.border}]} accessibilityLabel="Recording upload recovery">
      <StatusBadge label={label} tone={saving ? "info" : statusTone(label)} />
      <Text style={[styles.title, {color: colors.textPrimary}]}>{proof.transaction?.itemTitle || "Your recording"}</Text>
      <Text style={[styles.message, {color: colors.textSecondary}]}>{view.message}</Text>
      {live ? <ProgressState label="Recording upload" showLabel={false} percent={app.uploadProgressByProof[proof.proofId]} /> : null}
      {live || saving ? <Text style={[styles.detail, {color: colors.textSecondary}]}>You can leave this screen and start another Proof.</Text> : null}
      {view.resume && capture ? <Button label={view.resume} disabled={app.busy || app.offline} onPress={() => { void app.resumeSavedCapture(capture); }} /> : null}
      {view.discard ? <Button label={view.discard} variant="destructive" disabled={app.busy} onPress={discard} /> : null}
    </View>;
  })}</>;
}
const styles = StyleSheet.create({
  card: {borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md},
  title: {...typography.cardTitle}, message: {...typography.secondary}, detail: {...typography.finePrint},
});
