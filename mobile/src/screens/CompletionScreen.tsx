import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { recordCompletionState } from "../copy/proof-record";
import { haptic } from "../theme/haptics";
import { useTheme } from "../theme/ThemeProvider";
import { spacing, typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";

export function CompletionScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proof = app.proof;
  const state = recordCompletionState(proof?.status);
  const celebrated = useRef<string | null>(null);
  const local = app.savedRecordings.filter(capture => capture.captureProofId === proof?.proofId);
  const preservationPending = local.some(capture => capture.recovery?.phase === "SUBMITTED");
  const hasCurrentCapture = Boolean(app.localCapture && app.session?.captureProofId === proof?.proofId);
  useEffect(() => {
    if (state.finalized && proof && celebrated.current !== proof.proofId) {
      celebrated.current = proof.proofId;
      void haptic("success");
    }
  }, [state.finalized, proof?.proofId]);
  function finish() {
    if (!proof) { app.go("orders"); return; }
    if (state.finalized) { app.go("proof"); return; }
    if (hasCurrentCapture) { app.go("capture"); return; }
    if (proof.status === "EVIDENCE_COMMITTED") { void app.finalizeProof(); return; }
    void app.run(async () => { await app.refreshProof(proof.proofId); });
  }
  return <AppScreen extraBottom={24}>
    <AppHeader title={state.finalized ? "Proof saved" : "Finish saving"} onBack={app.goBack} />
    <ErrorBanner message={app.error} />
    <OfflineBanner visible={app.offline} />
    <View style={styles.result} accessibilityLiveRegion="polite">
      <Ionicons name={state.finalized ? "checkmark-circle-outline" : "time-outline"} size={40} color={state.finalized ? colors.success : colors.textSecondary} />
      <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>{state.title}</Text>
      {proof?.transaction.itemTitle ? <Text style={[styles.item, { color: colors.textPrimary }]}>{proof.transaction.itemTitle}</Text> : null}
      <Text style={[styles.body, { color: colors.textSecondary }]}>{state.finalized
        ? "Your recording and shipping declaration are locked in this Proof. Carrier updates and later recordings can be added separately."
        : hasCurrentCapture || local.length ? "Your recording is kept on this device. PackProof still needs to finish saving the Proof." : "PackProof has not confirmed a finished Proof. Check its status to continue."}</Text>
      {state.finalized && preservationPending ? <Text style={[styles.note, { color: colors.textSecondary }]}>Your local recording is kept while preservation is confirmed.</Text> : null}
    </View>
    <Button label={proof ? state.finalized ? "View Proof" : hasCurrentCapture || proof.status === "EVIDENCE_COMMITTED" ? "Finish saving" : "Check status" : "Orders"} onPress={finish} loading={app.busy} />
    {proof ? <Button label={app.batchPacking ? state.finalized ? "Pack next order" : "Back to queue" : "Orders"} variant="tertiary" onPress={() => app.go(app.batchPacking ? "station" : "orders")} /> : null}
  </AppScreen>;
}

const styles = StyleSheet.create({
  result: { gap: spacing.md, paddingVertical: spacing.lg },
  title: { ...typography.pageTitle }, item: { ...typography.bodyStrong },
  body: { ...typography.body }, note: { ...typography.secondary },
});
