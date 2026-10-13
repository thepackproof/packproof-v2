import { CompactProofRow } from '../ui/CompactProofRow';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { useTaskHome } from "../experience/use-task-home";
import { formatDate } from "../copy/format";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { TutorialTarget, useFirstExperience } from "../onboarding/Onboarding";
import { FIRST_PROOF_EXPERIENCE_ENABLED } from "../experience/first-proof";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/EmptyState";
import { PressableScale } from "../ui/motion";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";

export function TaskHomeScreen() {
  const app = usePackProof(), home = useTaskHome(), { colors } = useTheme();
  const experience = useFirstExperience();
  const {fontScale}=useWindowDimensions();
  const quietHome = FIRST_PROOF_EXPERIENCE_ENABLED && home.empty;
  const firstProof = quietHome && experience.status === "FIRST_PROOF";
  function library(view: "all" | "attention" | "completed") {
    app.setProofsView(view); app.setProofsQuery(""); app.setProofsRoleFilter("all"); app.setProofsCarrierFilter(null); app.go("proofs");
  }
  const selected = home.recommendation;
  const action = selected.kind === 'create_proof' ? {...selected, title:firstProof?'Keep your evidence together':'Start a new Proof', buttonLabel:'Create Proof', reason:'Document an item or shipment, review the evidence, then finalize your record.'} : selected;
  const additional = home.attention.filter(row => row.proof.proofId !== action.targetId).slice(0,3);
  return <AppScreen padded={false} bottomInset={false} restorationReady={!home.loading} initialOffsetY={app.readWorkspaceOffset("home")} onScrollOffset={offset => app.setWorkspaceOffset("home", offset)} onRefresh={() => void home.refresh()} refreshing={home.refreshing}>
    <View style={styles.content}>
      <WorkspaceHeader section="Home" />
      <View onTouchStart={() => home.setInteracting(true)} onTouchEnd={() => home.setInteracting(false)} onTouchCancel={() => home.setInteracting(false)} style={[styles.next, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {home.loading ? <View accessibilityLabel="Loading your next action" accessibilityRole="progressbar" style={styles.placeholder}>
          <View style={[styles.line, { backgroundColor: colors.surfaceElevated, width: "38%" }]} /><View style={[styles.titleLine, { backgroundColor: colors.surfaceElevated }]} /><View style={[styles.line, { backgroundColor: colors.surfaceElevated }]} /><View style={[styles.buttonPlaceholder, { backgroundColor: colors.surfaceElevated }]} />
        </View> : <>
          <Text style={[styles.state, { color: colors.accentText }]}>{action.sourceFreshness === "device" ? "Saved on this device" : action.kind === "create_proof" ? "Ready when you are" : "Continue where you left off"}</Text>
          <Text accessibilityRole="header" style={[styles.actionTitle, { color: colors.textPrimary }]}>{action.title}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{action.reason}</Text>
          <TutorialTarget name="capture"><PressableScale accessibilityRole="button" accessibilityLabel={action.buttonLabel} accessibilityState={{ disabled: app.busy, busy: app.busy }} disabled={app.busy} onFocus={() => home.setInteracting(true)} onBlur={() => home.setInteracting(false)} onPressIn={() => home.setInteracting(true)} onPressOut={() => home.setInteracting(false)} onPress={() => void home.runAction(action)} style={[styles.primaryAction, { backgroundColor: app.busy ? colors.disabledBackground : colors.primary }]}>{app.busy ? <ActivityIndicator color={colors.disabledText} /> : <Text style={[typography.button, { color: colors.textOnPrimary, textAlign: "center" }]}>{action.buttonLabel}</Text>}</PressableScale></TutorialTarget>
        </>}
      </View>
      {FIRST_PROOF_EXPERIENCE_ENABLED && !home.loading && action.kind === "create_proof" ? <Button label="See a sample Proof" variant="tertiary" onPress={() => app.go("sample")} /> : null}
      {home.loading || action.kind !== "create_proof" ? <TutorialTarget name="create"><Button label="Create Proof" icon="add-outline" variant="secondary" disabled={app.busy} onPress={() => app.selectCreateProof()} /></TutorialTarget> : null}
      {app.offline ? <Text style={[styles.body, { color: colors.warningText }]}>Offline. Saved work remains on this device. Connect before creating a Proof.</Text> : null}
      {(!app.workspaceReconciled || app.offline) && home.freshnessLabel ? <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.textMuted }]}>{home.freshnessLabel}</Text> : null}
      <ErrorBanner message={home.error} />
      {home.error ? <Button label="Refresh your records" variant="tertiary" onPress={() => void home.refresh()} /> : null}
      {!quietHome && <View style={[styles.metrics,fontScale>1.4 && {flexDirection:"column"}]}>
        {[
          { label: "Action needed", value: home.counts.attention, detail: "Proofs", onPress: () => library("attention") },
          { label: "Uploads", value: home.counts.uploading, detail: "Saved uploads", onPress: () => app.go("activity", { activityFilter: "uploading" }) },
          { label: "Completed", value: home.counts.completed, detail: "All time", onPress: () => library("completed") },
        ].map(metric => <View key={metric.label} style={{ flex: 1 }}><PressableScale accessibilityRole="button" accessibilityLabel={`${metric.label}: ${home.loading ? "loading" : metric.value}. ${metric.detail}`} onPress={metric.onPress} style={[styles.metric, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.metricValue, { color: colors.textPrimary }]}>{home.loading ? "—" : metric.value}</Text><Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{metric.label}</Text></PressableScale></View>)}
      </View>}
      {home.counts.waiting > 0 ? <Button label={`${home.counts.waiting} ${home.counts.waiting === 1 ? "job" : "jobs"} ${app.offline ? "waiting for connection" : "waiting to upload"}`} variant="tertiary" onPress={() => app.go("activity", { activityFilter: "uploading" })} /> : null}
      {additional.length > 0 ? <TutorialTarget name="attention"><View style={styles.section}>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Also needs action</Text><Button label="View all" variant="tertiary" onPress={() => library("attention")} /></View>
        {additional.map(({ proof, action: next }) => <CompactProofRow key={proof.proofId} title={proof.transaction.itemTitle || 'Shipment Proof'} detail={next.reason} disabled={app.busy} onPress={() => void home.runAction(next)} />)}
      </View></TutorialTarget> : null}
      {!quietHome && <TutorialTarget name="proofs"><View style={styles.section}>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Recent Proofs</Text><Button label="View all" variant="tertiary" onPress={() => library("all")} /></View>
        {home.recent.filter(proof=>proof.proofId!==action.targetId).slice(0,3).map(proof => <CompactProofRow key={proof.proofId} title={proof.transaction.itemTitle || 'Shipment Proof'} detail={`${proof.presentation.displayStatus} · ${formatDate(proof.updatedAt)}`} completed={proof.presentation.completed} disabled={app.busy} onPress={() => void home.openProof(proof)} />)}
        {!home.loading && !home.recent.length ? <Text style={[styles.body, { color: colors.textSecondary }]}>{home.attention.length ? "Your other recent Proofs will appear here." : "Record the item, packing, seal and label in one continuous video. Your Proofs will appear here."}</Text> : null}
      </View></TutorialTarget>}
    </View>
  </AppScreen>;
}
const styles = StyleSheet.create({ primaryAction: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 10, justifyContent: "center", alignItems: "center" }, content: { paddingHorizontal: 16, paddingTop: 8, gap: 14 }, next: { borderWidth: 1, borderRadius: 18, padding: 16, gap: 10 }, state: { ...typography.secondaryStrong, fontSize: 12, lineHeight: 18 }, actionTitle: { ...typography.sectionTitle, fontSize: 22, lineHeight: 29 }, body: { ...typography.secondary, fontSize: 14, lineHeight: 21 }, meta: { ...typography.finePrint, fontSize: 12, lineHeight: 18 }, metrics: { flexDirection: "row", gap: 6 }, metric: { borderWidth: 0, borderRadius: 10, minHeight: 64, paddingHorizontal: 8, paddingVertical: 8, gap: 2 }, metricValue: { ...typography.sectionTitle, fontSize: 22, lineHeight: 28 }, metricLabel: { ...typography.secondaryStrong, fontSize: 12, lineHeight: 18 }, metricDetail: { ...typography.finePrint, fontSize: 11, lineHeight: 17 }, section: { gap: 10 }, sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, heading: { ...typography.bodyStrong, fontSize: 17, lineHeight: 24, flexShrink: 1 }, record: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 5, minHeight: 72 }, recordTitle: { ...typography.bodyStrong, fontSize: 15, lineHeight: 22 }, placeholder: { gap: 12, minHeight: 172 }, line: { height: 18, borderRadius: 5 }, titleLine: { height: 29, borderRadius: 5, width: "80%" }, buttonPlaceholder: { height: 48, borderRadius: 8, marginTop: 12 } });
