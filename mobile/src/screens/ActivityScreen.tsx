import {SIGNAL_ENABLED} from "../experience/signal";
import {SignalText,SignalBadge} from "../ui/Signal";
import { SavedPhotoDraft } from '../ui/SavedPhotoDraft';
import { RetainedRecordingInspection } from '../ui/RetainedRecordingInspection';
import { selectRecoveryWorkspace } from '../experience/recovery-workspace';
import { CompactProofRow } from '../ui/CompactProofRow';
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
import { typography, taskFirstTypography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { ProgressState } from "../ui/EvidenceCard";
import { PressableScale } from "../ui/motion";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";
import { activityGroup, activityRecordingUsable } from "../experience/activity-model";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";
import { recoveryPresentation, recordingRepresentedByTask, recordingTaskSession, markNotificationAfterOpen } from "../experience/recovery-presentation";
import { captureCompletionActive } from "../capture/completion";
import { AppHeader } from "../ui/AppHeader";
import { StatusBadge } from "../ui/StatusBadge";
import { proofDisplayTitle } from "../copy/proof-title";

const TASK_UI = SIGNAL_ENABLED || ANDROID_TASK_FIRST_REBUILD;

export function ActivityScreen() {
  const app = usePackProof(), { colors } = useTheme();
  const filter = app.route.activityFilter ?? "all";
  const selectedSessionId = app.route.activitySessionId;
  const [notifications, setNotifications] = useState<ProofNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const scope = `${app.apiBaseUrl}:${app.session?.userId ?? ""}`;
  useEffect(() => {
    let active = true;
    setNotifications([]); setNotificationError(null); setNotificationsLoading(true);
    const account = app.session;
    if (!account) { setNotificationsLoading(false); return; }
    void app.ensureAuth().then(() => { app.client.assertCaptureAccount(account.userId, account.apiBaseUrl); return app.client.notificationRequest<{ notifications: ProofNotification[] }>("notifications"); })
      .then(result => { app.client.assertCaptureAccount(account.userId, account.apiBaseUrl); if (active) setNotifications(result.notifications); })
      .catch(() => { if (active) setNotificationError("Notifications could not be refreshed. Saved recordings remain available."); }).finally(() => { if(active)setNotificationsLoading(false); });
    return () => { active = false; };
  }, [scope, generation]);
  const recordings = useMemo(() => workspaceRecordings(app.savedRecordings, app.localCapture).filter(capture => capture.captureUserId === app.session?.userId && capture.recovery?.apiBaseUrl.replace(/\/+$/, "") === app.apiBaseUrl.replace(/\/+$/, "")), [app.savedRecordings, app.localCapture, scope]);
  const workspace = selectRecoveryWorkspace({ proofs: app.proofCollection, invitations: app.pendingInvites, captures: recordings, photoDrafts: app.photoDrafts, orders: [], progress: app.uploadProgressByProof, userId: app.session?.userId ?? '', apiBaseUrl: app.apiBaseUrl, online: !app.offline, reconciled: app.workspaceReconciled, captureStatus: app.captureStatus });
  useEffect(() => { void app.run(app.syncWorkspace); }, [scope]);
  const selectedRecording = selectedSessionId ? recordings.find(capture => (capture.captureSessionId || capture.uri) === selectedSessionId || capture.recovery?.operationId === selectedSessionId) : undefined;
  function openAttentionTask(row: (typeof workspace.attention)[number]) {
    const sessionId = TASK_UI ? recordingTaskSession(row, recordings) : null;
    if (sessionId) app.go("activity", { activitySessionId: sessionId, activityFilter: "all" });
    else void app.openProofAction(row.proofId);
  }
  const groups = [
    { id: "attention", title: "Saved recordings needing action" },
    { id: "uploading", title: TASK_UI ? "In progress" : "Uploads" },
    { id: "completed", title: "Saved recording copies" },
  ] as const;
  if(SIGNAL_ENABLED&&!selectedSessionId)return <AppScreen bottomInset={false} initialOffsetY={app.readWorkspaceOffset('activity')} onScrollOffset={offset=>app.setWorkspaceOffset('activity',offset)} onRefresh={()=>{setGeneration(value=>value+1);void app.run(app.syncWorkspace);}} refreshing={app.busy}><WorkspaceHeader section="Activity"/><SignalText kind="mono" muted>YOUR PROOFS, AS THEY HAPPEN.</SignalText><SignalText kind="title">Activity</SignalText><SignalText muted>Recording, saving, and the moments in between.</SignalText><OfflineBanner visible={app.offline}/><ErrorBanner message={app.error}/><SignalText kind="mono" muted>RECORDING UPDATES</SignalText>{recordings.length?recordings.slice().sort((a,b)=>Date.parse(b.recovery?.updatedAt||'')-Date.parse(a.recovery?.updatedAt||'')).map(capture=><SignalActivityRow key={capture.recovery?.operationId||capture.uri} capture={capture}/>):<SignalText kind="small" muted>Your recording updates will appear here.</SignalText>}{workspace.photoDrafts.map(draft=><SavedPhotoDraft key={draft.id} draft={draft} openProof/>)}<SignalText kind="mono" muted>PROOF UPDATES</SignalText>{notificationError&&<ErrorBanner message={notificationError}/>} {notificationsLoading?<SignalText kind="small" muted>Loading recent updates…</SignalText>:notifications.map(update=><PressableScale key={update.id} accessibilityRole="button" disabled={app.busy} onPress={()=>void app.run(async()=>{await markNotificationAfterOpen(()=>app.openProofAction(update.proofId),()=>app.client.notificationRequest(`notifications/${encodeURIComponent(update.id)}/read`,'POST',{}));})} style={{paddingVertical:16,gap:6,borderBottomWidth:1,borderColor:colors.border}}><SignalText kind="strong">{update.title}</SignalText><SignalText kind="small" muted>{app.proofCollection.find(row=>row.proofId===update.proofId)?.transaction.itemTitle||'Proof update'}</SignalText><SignalText kind="mono" muted>{formatDateTime(update.createdAt)}</SignalText></PressableScale>)}{!notificationsLoading&&!notifications.length&&!notificationError&&<SignalText kind="small" muted>No recent Proof updates.</SignalText>}<Button label="Notification preferences" variant="tertiary" onPress={()=>app.go('account',{accountSection:'notifications'})}/></AppScreen>;
  return <AppScreen bottomInset={false} initialOffsetY={selectedSessionId ? 0 : app.readWorkspaceOffset("activity")} onScrollOffset={offset => { if (!selectedSessionId) app.setWorkspaceOffset("activity", offset); }} resetScrollKey={`${filter}:${selectedSessionId ?? ""}`} onRefresh={() => { setGeneration(value => value + 1); void app.run(app.syncWorkspace); }} refreshing={app.busy}>
    {TASK_UI && selectedSessionId ? <AppHeader title="Recording details" onBack={() => app.go("activity", { activityFilter: "all" })} /> : <WorkspaceHeader section={TASK_UI ? "Activity" : "Updates"} />}
    {!TASK_UI || !selectedSessionId ? <Text accessibilityRole="header" style={[styles.title, TASK_UI && taskFirstTypography.pageTitle, { color: colors.textPrimary }]}>{TASK_UI ? "Activity" : "Updates"}</Text> : null}
    {!selectedSessionId ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} accessibilityRole="tablist" accessibilityLabel="Update filters">
      {([["all", "All"], ["attention", "Action needed"], ["uploading", TASK_UI ? "In progress" : "Uploading"], ["notifications", TASK_UI ? "For you" : "Notifications"], ["completed", "Saved copies"]] as const).map(([id, label]) => <PressableScale key={id} accessibilityRole="tab" accessibilityState={{ selected: filter === id }} onPress={() => app.go("activity", { activityFilter: id })} style={[styles.filter, { backgroundColor: filter === id ? colors.accentSoft : colors.surface }]}><Text style={[styles.text, { color: filter === id ? colors.accentText : colors.textSecondary }]}>{label}</Text></PressableScale>)}
    </ScrollView> : null}
    <OfflineBanner visible={app.offline} /><ErrorBanner message={app.error} />
    {TASK_UI && !selectedSessionId ? <Button label="View tasks in Proofs" variant="tertiary" onPress={() => {app.setProofsView('attention');app.go('proofs');}} /> : null}
    {!TASK_UI && !selectedSessionId && (filter === 'all' || filter === 'attention') ? <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.heading,{color:colors.textPrimary}]}>{TASK_UI ? "Proofs needing action" : "Action needed"} · {workspace.attention.length}</Text>
      {workspace.attention.map(row => <CompactProofRow key={row.proofId} title={TASK_UI ? proofDisplayTitle(row) : row.transaction.itemTitle || 'Proof'} detail={row.taskDescription} disabled={app.busy} onPress={() => openAttentionTask(row)} />)}
      {!workspace.attention.length ? <Text style={[styles.text,{color:colors.textSecondary}]}>{app.workspaceReconciled ? 'No Proofs need action.' : 'Refresh your Proofs to check what needs action.'}</Text> : null}
    </View> : null}
    {!selectedSessionId && (filter === 'all' || filter === 'uploading') && workspace.photoDrafts.some(draft => draft.phase === 'SUBMITTING') ? <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Photo submissions</Text>
      {workspace.photoDrafts.filter(draft => draft.phase === 'SUBMITTING').map(draft => <SavedPhotoDraft key={draft.id} draft={draft} openProof />)}
    </View> : null}
    {!selectedSessionId && filter === 'completed' ? <View style={styles.group}>
      <Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Photo originals</Text>
      {app.photoDrafts.length ? app.photoDrafts.map(draft => <SavedPhotoDraft key={draft.id} draft={draft} openProof />) : <Text style={[styles.text, { color: colors.textSecondary }]}>No photo originals saved on this device.</Text>}
    </View> : null}
    {selectedSessionId ? <View style={styles.group}>
      {!TASK_UI ? <Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Selected recording</Text> : null}
      {selectedRecording ? <View style={TASK_UI ? undefined : { borderWidth: 2, borderColor: colors.accent, borderRadius: 14, padding: 2 }}><ActivityRecordingRow key={selectedSessionId} capture={selectedRecording} focused /></View> : <Text accessibilityLiveRegion="polite" style={[styles.text, { color: colors.textSecondary }]}>This recording is no longer available in the current account's local Updates. View all Updates to check its latest state.</Text>}
      {!TASK_UI || !selectedRecording ? <Button label="View all Updates" variant="secondary" onPress={() => app.go("activity", { activityFilter: "all" })} /> : null}
    </View> : groups.filter(section => (filter === "all" && section.id !== "completed") || filter === section.id).map(section => {
      const rows = recordings.filter(capture => activityGroup(capture) === section.id && (section.id !== 'attention' || (TASK_UI
        ? true
        : !workspace.attention.some(row=>row.proofId===capture.captureProofId))));
      if (!rows.length && (section.id === 'attention' || section.id === 'uploading' && workspace.photoDrafts.some(draft => draft.phase === 'SUBMITTING'))) return null;
      return <View key={section.id} style={styles.group}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>{section.title}</Text>
        {rows.length ? rows.map(capture => <ActivityRecordingRow key={capture.recovery?.operationId ?? capture.uri} capture={capture} />) : <Text style={[styles.text, { color: colors.textSecondary }]}>{section.id === "attention" ? "No recordings need your action." : section.id === "uploading" ? "No uploads in progress." : "Finalized recordings will appear here."}</Text>}
      </View>;
    })}
    {!selectedSessionId && (filter === "all" || filter === "notifications") ? <View style={styles.group}>
      <View style={styles.headingRow}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Notifications</Text><Button label="Preferences" variant="tertiary" onPress={() => app.go("account", { accountSection: "notifications" })} /></View>
      {notificationError ? <><Text style={[styles.text, { color: colors.textSecondary }]}>{notificationError}</Text><Button label="Retry notifications" variant="tertiary" onPress={() => setGeneration(value => value + 1)} /></> : null}
      {notificationsLoading ? <Text accessibilityLiveRegion="polite" style={[styles.text,{color:colors.textSecondary}]}>Loading recent updates…</Text> : null}
      {!notificationsLoading && !notificationError && !notifications.length ? <Text style={[styles.text, { color: colors.textSecondary }]}>Proof updates will appear here.</Text> : null}
      {notifications.map(update => <CompactProofRow key={update.id} title={update.title} detail={`${app.proofCollection.find(row=>row.proofId===update.proofId)?.transaction.itemTitle || 'Proof update'} · ${formatDateTime(update.createdAt)}`} disabled={app.busy} onPress={() => void app.run(async () => {
        if (TASK_UI) {
          await markNotificationAfterOpen(() => app.openProofAction(update.proofId), () => app.client.notificationRequest(`notifications/${encodeURIComponent(update.id)}/read`, 'POST', {}));
        } else {
          await app.openProofAction(update.proofId);
          await app.client.notificationRequest(`notifications/${encodeURIComponent(update.id)}/read`, 'POST', {}).catch(() => undefined);
        }
      })} />)}
    </View> : null}
  </AppScreen>;
}

export function ActivityRecordingRow({ capture, focused = false }: { capture: LocalCapture; focused?: boolean }) {
  return TASK_UI ? <AndroidRecordingRow capture={capture} focused={focused} /> : <LegacyRecordingRow capture={capture} />;
}

function LegacyRecordingRow({ capture }: { capture: LocalCapture }) {
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
    {invalid ? <RetainedRecordingInspection capture={capture} /> : null}
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

function AndroidRecordingRow({ capture, focused }: { capture: LocalCapture; focused: boolean }) {
  const app = usePackProof(), { colors } = useTheme();
  const [details, setDetails] = useState(false);
  const state = capture.recovery;
  if (!state) return null;
  const proof = app.proofCollection.find(row => row.proofId === capture.captureProofId);
  const view = recoveryPresentation(capture, { offline: app.offline, active: captureCompletionActive(state.operationId), proofFinalized: proof?.status === "FINALIZED" });
  const title = proof ? proofDisplayTitle(proof) : "Saved shipment recording";
  const completed = mayCleanUpCapture(state);
  const progress = capture.captureProofId ? app.uploadProgressByProof[capture.captureProofId] : undefined;
  const tone = view.tone === "success" ? "success" : view.tone === "attention" ? "warning" : view.tone === "error" ? "error" : "info";
  if (!focused) return <CompactProofRow title={title} detail={view.title} disabled={app.busy}
    completed={view.tone === "success"} tone={view.tone === "success" ? "neutral" : view.tone}
    icon={view.live ? "cloud-upload-outline" : undefined}
    onPress={() => app.go("activity", { activitySessionId: capture.captureSessionId || state.operationId, activityFilter: "all" })} />;
  function primaryAction() {
    if (view.action === "resume") void app.resumeSavedCapture(capture);
    else if (view.action === "view" && capture.captureProofId) void app.run(() => app.openProof(capture.captureProofId!));
    else if (view.action === "refresh") void app.run(app.syncWorkspace);
    else if (view.action === "details") setDetails(true);
  }
  function discard() {
    Alert.alert(completed ? "Remove completed local copy?" : "Discard this local recording?",
      completed ? "PackProof will recheck the preservation and finalization receipts. Committed server evidence remains available."
        : "PackProof will close this incomplete upload before removing its local original. It cannot be recovered after removal. Committed server evidence is unchanged.",
      [{ text: "Keep recording", style: "cancel" }, { text: "Remove local recording", style: "destructive", onPress: () => completed ? void app.cleanUpSavedCapture(capture) : void app.discardSavedCapture(capture) }]);
  }
  return <View style={styles.group}>
    <Text accessibilityRole="header" style={[taskFirstTypography.cardTitle, { color: colors.textPrimary }]}>{title}</Text>
    <StatusBadge label={view.title} tone={tone} />
    {capture.replacement?.decision==='pending'&&<Button label="Keep previous take" onPress={()=>void app.chooseCaptureTake('original',capture)} disabled={app.busy}/>}
    <Text style={[taskFirstTypography.body, { color: colors.textSecondary }]}>{view.message}</Text>
    {view.live ? <ProgressState label="Uploading your recording" percent={typeof progress === "number" && Number.isFinite(progress) && progress < 100 ? progress : null} /> : null}
    {state.lastError && activityGroup(capture) === "attention" ? <Text accessibilityRole="alert" style={[taskFirstTypography.secondary, { color: colors.warningText }]}>{formatUserFacingError(state.lastError)}</Text> : null}
    {!activityRecordingUsable(capture) ? <RetainedRecordingInspection capture={capture} /> : null}
    {view.actionLabel ? <Button label={view.actionLabel} loading={app.busy} onPress={primaryAction} /> : null}
    {capture.captureProofId && view.action !== "view" ? <Button label="View Proof" variant="tertiary" disabled={app.busy} onPress={() => void app.run(() => app.openProof(capture.captureProofId!))} /> : null}
    {view.action !== "details" || details ? <Button label={details ? "Hide file and recovery options" : "File and recovery options"} variant="tertiary" onPress={() => setDetails(value => !value)} /> : null}
    {details ? <View style={[styles.group, { borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 }]}>
      <Text style={[taskFirstTypography.secondary, { color: colors.textSecondary }]}>{formatBytes(capture.byteSize)} · {formatDateTime(state.updatedAt)}{capture.captureStageId ? " · Receipt or return stage" : ""}</Text>
      <Text selectable style={[taskFirstTypography.finePrint, { color: colors.textSecondary }]}>Proof: {capture.captureProofId || "Unavailable"}{"\n"}Recording: {capture.captureSessionId || state.operationId}</Text>
      {capture.localFileAvailable !== false ? <Button label="Export local recording" variant="secondary" disabled={app.busy} onPress={() => void app.run(async () => { await Sharing.shareAsync(capture.uri, { mimeType: capture.contentType, dialogTitle: "Export your original local recording" }); })} /> : null}
      <Button label={completed ? "Remove completed local copy" : "Discard local recording"} variant="tertiary" disabled={app.busy || state.phase === "UPLOADING" || state.phase === "DISCARD_PENDING"} onPress={discard} />
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({ title: { ...typography.pageTitle, fontSize: 24, lineHeight: 31 }, heading: { ...typography.bodyStrong, fontSize: 16, lineHeight: 23 }, text: { ...typography.secondary, fontSize: 14, lineHeight: 21 }, meta: { ...typography.finePrint, fontSize: 12, lineHeight: 18 }, group: { gap: 12 }, card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 }, filters: { gap: 6 }, filter: { minHeight: 48, paddingHorizontal: 13, paddingVertical: 12, justifyContent: "center", borderRadius: 8 }, headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 } });

function SignalActivityRow({capture}:{capture:LocalCapture}){
 const app=usePackProof(),{colors}=useTheme();const state=capture.recovery;if(!state)return null;
 const proof=app.proofCollection.find(row=>row.proofId===capture.captureProofId);
 const view=recoveryPresentation(capture,{offline:app.offline,active:captureCompletionActive(state.operationId),proofFinalized:proof?.status==='FINALIZED'});
 const saved=mayCleanUpCapture(state)&&proof?.status==='FINALIZED';
 return <PressableScale accessibilityRole="button" accessibilityLabel={`${proof?.transaction.itemTitle||'Packing recording'}. ${view.title}`} onPress={()=>app.go('activity',{activitySessionId:capture.captureSessionId||state.operationId,activityFilter:'all'})} style={{flexDirection:'row',gap:16,paddingVertical:20,borderBottomWidth:1,borderColor:colors.border}}><View style={{width:36,height:36,borderRadius:18,backgroundColor:saved?colors.successSoft:colors.surfacePressed,alignItems:'center',justifyContent:'center'}}><Text style={{color:saved?colors.successText:colors.textSecondary}}>{saved?'✓':view.live?'↑':'○'}</Text></View><View style={{flex:1,gap:8}}><SignalText kind="strong">{saved?'Proof saved':view.title}</SignalText><SignalText kind="small" muted>{proof?.transaction.itemTitle||'Packing recording'}</SignalText><SignalText kind="mono" muted>{formatDateTime(state.updatedAt)}</SignalText><SignalBadge state={saved?'saved':view.live?'uploading':'local'}>{saved?'Saved to PackProof':view.live?'Uploading':view.title}</SignalBadge></View></PressableScale>;
}
