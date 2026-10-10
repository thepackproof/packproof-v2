import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import { usePackProof } from "../app/PackProofProvider";
import { formatBytes, type LocalCapture } from "../capture";
import { captureRecoveryLabel, mayCleanUpCapture } from "../capture/recovery-model";
import { formatUserFacingError } from "../copy/errors";
import { formatDateTime } from "../copy/format";
import { workspaceRecordings } from "../copy/workspace-summary";
import type { ProofNotification } from "../notifications/client";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { ProgressState } from "../ui/EvidenceCard";
import { PressableScale } from "../ui/motion";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";
import { activityGroup, activityRecordingUsable } from "../experience/activity-model";

export function ActivityScreen() {
  const app = usePackProof(), { colors } = useTheme();
  const filter = app.route.activityFilter ?? "all";
  const selectedSessionId = app.route.activitySessionId;
  const [notifications, setNotifications] = useState<ProofNotification[]>([]);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const scope = `${app.apiBaseUrl}:${app.session?.userId ?? ""}`;
  useEffect(() => {
    let active = true;
    setNotifications([]); setNotificationError(null);
    const account = app.session;
    if (!account) return;
    void app.ensureAuth().then(() => { app.client.assertCaptureAccount(account.userId, account.apiBaseUrl); return app.client.notificationRequest<{ notifications: ProofNotification[] }>("notifications"); })
      .then(result => { app.client.assertCaptureAccount(account.userId, account.apiBaseUrl); if (active) setNotifications(result.notifications); })
      .catch(() => { if (active) setNotificationError("Notifications could not be refreshed. Saved recordings remain available."); });
    return () => { active = false; };
  }, [scope, generation]);
  const recordings = useMemo(() => workspaceRecordings(app.savedRecordings, app.localCapture).filter(capture => capture.captureUserId === app.session?.userId && capture.recovery?.apiBaseUrl.replace(/\/+$/, "") === app.apiBaseUrl.replace(/\/+$/, "")), [app.savedRecordings, app.localCapture, scope]);
  const selectedRecording = selectedSessionId ? recordings.find(capture => (capture.captureSessionId || capture.uri) === selectedSessionId || capture.recovery?.operationId === selectedSessionId) : undefined;
  const groups = [
    { id: "attention", title: "Needs your attention" },
    { id: "uploading", title: "In progress" },
    { id: "completed", title: "Completed recordings" },
  ] as const;
  return <AppScreen bottomInset={false} initialOffsetY={selectedSessionId ? 0 : app.readWorkspaceOffset("activity")} onScrollOffset={offset => { if (!selectedSessionId) app.setWorkspaceOffset("activity", offset); }} resetScrollKey={`${filter}:${selectedSessionId ?? ""}`} onRefresh={() => { setGeneration(value => value + 1); void app.run(app.syncWorkspace); }} refreshing={app.busy}>
    <WorkspaceHeader section="Activity" />
    <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>Activity</Text>
    {!selectedSessionId ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} accessibilityRole="tablist" accessibilityLabel="Activity filters">
      {([["all", "All"], ["attention", "Needs attention"], ["uploading", "In progress"], ["completed", "Completed"]] as const).map(([id, label]) => <PressableScale key={id} accessibilityRole="tab" accessibilityState={{ selected: filter === id }} onPress={() => app.go("activity", { activityFilter: id })} style={[styles.filter, { backgroundColor: filter === id ? colors.accentSoft : colors.surface }]}><Text style={[styles.text, { color: filter === id ? colors.accentText : colors.textSecondary }]}>{label}</Text></PressableScale>)}
    </ScrollView> : null}
    <OfflineBanner visible={app.offline} /><ErrorBanner message={app.error} />
    {selectedSessionId ? <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Selected recording</Text>
      {selectedRecording ? <View style={{ borderWidth: 2, borderColor: colors.accent, borderRadius: 14, padding: 2 }}><ActivityRecordingRow key={selectedSessionId} capture={selectedRecording} /></View> : <Text accessibilityLiveRegion="polite" style={[styles.text, { color: colors.textSecondary }]}>This recording is no longer available in the current account's local Activity. View all Activity to check its latest state.</Text>}
      <Button label="View all Activity" variant="secondary" onPress={() => app.go("activity", { activityFilter: "all" })} />
    </View> : groups.filter(section => filter === "all" || filter === section.id).map(section => {
      const rows = recordings.filter(capture => activityGroup(capture) === section.id);
      return <View key={section.id} style={styles.group}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>{section.title}</Text>
        {rows.length ? rows.map(capture => <ActivityRecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />) : <Text style={[styles.text, { color: colors.textSecondary }]}>{section.id === "attention" ? "No recordings need your action." : section.id === "uploading" ? "No uploads in progress." : "Finalized recordings will appear here."}</Text>}
      </View>;
    })}
    {!selectedSessionId && (filter === "all" || filter === "completed") ? <View style={styles.group}>
      <View style={styles.headingRow}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Notifications</Text><Button label="Preferences" variant="tertiary" onPress={() => app.go("account", { accountSection: "notifications" })} /></View>
      {notificationError ? <><Text style={[styles.text, { color: colors.textSecondary }]}>{notificationError}</Text><Button label="Retry notifications" variant="tertiary" onPress={() => setGeneration(value => value + 1)} /></> : null}
      {!notificationError && !notifications.length ? <Text style={[styles.text, { color: colors.textSecondary }]}>Proof updates will appear here.</Text> : null}
      {notifications.map(update => <View key={update.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.text, { color: colors.textSecondary }]}>Notification · {formatDateTime(update.createdAt)}</Text><Button label={update.title} variant="tertiary" onPress={() => void app.run(async () => { await app.openProof(update.proofId); await app.client.notificationRequest(`notifications/${encodeURIComponent(update.id)}/read`, "POST", {}).catch(() => undefined); })} /></View>)}
    </View> : null}
  </AppScreen>;
}

export function ActivityRecordingRow({ capture }: { capture: LocalCapture }) {
  const app = usePackProof(), { colors } = useTheme();
  const [details, setDetails] = useState(false);
  const state = capture.recovery;
  if (!state) return null;
  const proof = app.proofCollection.find(row => row.proofId === capture.captureProofId);
  const invalid = !activityRecordingUsable(capture);
  const completed = mayCleanUpCapture(state);
  const passive = activityGroup(capture) === "uploading";
  const progress = capture.captureProofId ? app.uploadProgressByProof[capture.captureProofId] : undefined;
  const label = capture.localFileAvailable === false ? "Original recording unavailable on this device" : invalid ? "Recording did not finish saving a usable video" : app.offline && ["LOCAL_ONLY", "UPLOAD_QUEUED"].includes(state.phase) && state.submitRequested ? "Waiting for connection" : captureRecoveryLabel(state.phase);
  const discard = () => Alert.alert(completed ? "Remove completed local copy?" : "Discard this local recording?", completed ? "PackProof will recheck the preservation and finalization receipts. Committed server evidence remains available." : "Only this recording on this device will be removed. It cannot be recovered after removal. Committed server evidence is unchanged. Open the Proof afterward to begin a new continuous recording.", [{ text: "Keep recording", style: "cancel" }, { text: "Remove local recording", style: "destructive", onPress: () => completed ? void app.cleanUpSavedCapture(capture) : void app.discardSavedCapture(capture) }]);
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.heading, { color: colors.textPrimary }]}>{proof?.transaction.itemTitle || "Saved shipment recording"}</Text>
    <Text accessibilityLiveRegion="polite" style={[styles.text, { color: colors.textSecondary }]}>{label}</Text>
    <Text style={[styles.meta, { color: colors.textMuted }]}>{formatBytes(capture.byteSize)} · {formatDateTime(state.updatedAt)}{capture.captureStageId ? " · Receipt or return stage" : ""}</Text>
    {typeof progress === "number" && Number.isFinite(progress) && progress < 100 && state.phase === "UPLOADING" ? <ProgressState label="Uploading" percent={progress} /> : null}
    {!invalid && capture.interrupted ? <Text style={[styles.text, { color: colors.warningText }]}>Recording ended unexpectedly. Review the saved video before confirming it.</Text> : null}
    {state.lastError && !passive ? <Text style={[styles.text, { color: colors.warningText }]}>{formatUserFacingError(state.lastError)}</Text> : null}
    {!invalid && !passive && !["FINALIZED", "SUBMITTED"].includes(state.phase) ? <Button label={state.phase === "LOCAL_ONLY" ? "Review evidence" : "Review upload"} loading={app.busy} onPress={() => void app.resumeSavedCapture(capture)} /> : null}
    {invalid ? <Text style={[styles.text, { color: colors.textSecondary }]}>This recording cannot be resumed as continuous evidence. Review its details before discarding it and starting a new take.</Text> : null}
    {capture.captureProofId ? <Button label="View Proof" variant="tertiary" loading={app.busy} onPress={() => void app.run(() => app.openProof(capture.captureProofId!))} /> : null}
    <Button label={details ? "Hide recording details" : "Recording details"} variant="tertiary" onPress={() => setDetails(value => !value)} />
    {details ? <View style={styles.group}><Text selectable style={[styles.meta, { color: colors.textSecondary }]}>Proof: {capture.captureProofId || "Unavailable"}{"\n"}Recording: {capture.captureSessionId || state.operationId}</Text>
      {capture.localFileAvailable !== false ? <Button label="Export local recording" variant="secondary" loading={app.busy} onPress={() => void app.run(async () => { await Sharing.shareAsync(capture.uri, { mimeType: capture.contentType, dialogTitle: "Export your original local recording" }); })} /> : null}
      <Button label={completed ? "Remove completed local copy" : "Discard local recording"} variant="tertiary" disabled={app.busy || state.phase === "UPLOADING"} onPress={discard} />
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({ title: { ...typography.pageTitle, fontSize: 24, lineHeight: 31 }, heading: { ...typography.bodyStrong, fontSize: 16, lineHeight: 23 }, text: { ...typography.secondary, fontSize: 14, lineHeight: 21 }, meta: { ...typography.finePrint, fontSize: 12, lineHeight: 18 }, group: { gap: 12 }, card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 }, filters: { gap: 6 }, filter: { minHeight: 48, paddingHorizontal: 13, paddingVertical: 12, justifyContent: "center", borderRadius: 8 }, headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 } });
