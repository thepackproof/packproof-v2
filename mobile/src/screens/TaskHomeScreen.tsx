import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { useTaskHome } from "../experience/use-task-home";
import { formatDate } from "../copy/format";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { TutorialTarget } from "../onboarding/Onboarding";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/EmptyState";
import { PressableScale } from "../ui/motion";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";

export function TaskHomeScreen() {
  const app = usePackProof(), home = useTaskHome(), { colors } = useTheme();
  function library(view: "all" | "attention" | "completed") {
    app.setProofsView(view); app.setProofsQuery(""); app.setProofsRoleFilter("all"); app.setProofsCarrierFilter(null); app.go("proofs");
  }
  const action = home.recommendation;
  return <AppScreen padded={false} bottomInset={false} restorationReady={!home.loading} initialOffsetY={app.readWorkspaceOffset("home")} onScrollOffset={offset => app.setWorkspaceOffset("home", offset)} onRefresh={() => void home.refresh()} refreshing={home.refreshing}>
    <View style={styles.content}>
      <WorkspaceHeader section="Home" />
      <View onTouchStart={() => home.setInteracting(true)} onTouchEnd={() => home.setInteracting(false)} onTouchCancel={() => home.setInteracting(false)} style={[styles.next, { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder }]}>
        {home.loading ? <View accessibilityLabel="Loading your next action" accessibilityRole="progressbar" style={styles.placeholder}>
          <View style={[styles.line, { backgroundColor: colors.surfaceElevated, width: "38%" }]} /><View style={[styles.titleLine, { backgroundColor: colors.surfaceElevated }]} /><View style={[styles.line, { backgroundColor: colors.surfaceElevated }]} /><View style={[styles.buttonPlaceholder, { backgroundColor: colors.surfaceElevated }]} />
        </View> : <>
          <Text style={[styles.state, { color: colors.accentText }]}>{action.sourceFreshness === "device" ? "Saved on this device" : action.kind === "create_proof" ? "Ready when you are" : "Your next action"}</Text>
          <Text accessibilityRole="header" style={[styles.actionTitle, { color: colors.textPrimary }]}>{action.title}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{action.reason}</Text>
          <TutorialTarget name="capture"><PressableScale accessibilityRole="button" accessibilityLabel={action.buttonLabel} accessibilityState={{ disabled: app.busy, busy: app.busy }} disabled={app.busy} onFocus={() => home.setInteracting(true)} onBlur={() => home.setInteracting(false)} onPressIn={() => home.setInteracting(true)} onPressOut={() => home.setInteracting(false)} onPress={() => void home.runAction(action)} style={[styles.primaryAction, { backgroundColor: app.busy ? colors.disabledBackground : colors.primary }]}>{app.busy ? <ActivityIndicator color={colors.disabledText} /> : <Text style={[typography.button, { color: colors.textOnPrimary, textAlign: "center" }]}>{action.buttonLabel}</Text>}</PressableScale></TutorialTarget>
        </>}
      </View>
      {home.loading || action.kind !== "create_proof" ? <TutorialTarget name="create"><Button label="Create Proof" icon="add-outline" variant="secondary" disabled={app.busy} onPress={() => app.go("create")} /></TutorialTarget> : null}
      {app.offline ? <Text style={[styles.body, { color: colors.warningText }]}>Offline. Saved work remains on this device. Connect before creating a Proof.</Text> : null}
      {home.freshnessLabel ? <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.textMuted }]}>{home.freshnessLabel}</Text> : null}
      <ErrorBanner message={home.error} />
      {home.error ? <Button label="Refresh your records" variant="tertiary" onPress={() => void home.refresh()} /> : null}
      <View style={styles.metrics}>
        {[
          { label: "Needs attention", value: home.counts.attention, detail: "Records", onPress: () => library("attention") },
          { label: "Uploading", value: home.counts.uploading, detail: "Active jobs", onPress: () => app.go("activity", { activityFilter: "uploading" }) },
          { label: "Completed", value: home.counts.completed, detail: "All time", onPress: () => library("completed") },
        ].map(metric => <View key={metric.label} style={{ flex: 1 }}><PressableScale accessibilityRole="button" accessibilityLabel={`${metric.label}: ${home.loading ? "loading" : metric.value}. ${metric.detail}`} onPress={metric.onPress} style={[styles.metric, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.metricValue, { color: colors.textPrimary }]}>{home.loading ? "—" : metric.value}</Text><Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{metric.label}</Text><Text style={[styles.metricDetail, { color: colors.textMuted }]}>{metric.detail}</Text></PressableScale></View>)}
      </View>
      {home.counts.waiting > 0 ? <Button label={`${home.counts.waiting} ${home.counts.waiting === 1 ? "job" : "jobs"} ${app.offline ? "waiting for connection" : "waiting to upload"}`} variant="tertiary" onPress={() => app.go("activity", { activityFilter: "uploading" })} /> : null}
      {home.attention.length > 0 ? <TutorialTarget name="attention"><View style={styles.section}>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Needs attention</Text><Button label="View all" variant="tertiary" onPress={() => library("attention")} /></View>
        {home.attention.slice(0, 3).map(({ proof, action: next }) => <View key={proof.proofId} style={[styles.record, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text style={[styles.recordTitle, { color: colors.textPrimary }]}>{proof.transaction.itemTitle || "Shipment Proof"}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{next.reason}</Text>
          <Button label={next.buttonLabel} variant="tertiary" loading={app.busy} onPress={() => void home.runAction(next)} />
        </View>)}
      </View></TutorialTarget> : null}
      <TutorialTarget name="proofs"><View style={styles.section}>
        <View style={styles.sectionHeading}><Text accessibilityRole="header" style={[styles.heading, { color: colors.textPrimary }]}>Recent Proofs</Text><Button label="View all" variant="tertiary" onPress={() => library("all")} /></View>
        {home.recent.map(proof => <PressableScale key={proof.proofId} accessibilityRole="button" accessibilityLabel={`${proof.transaction.itemTitle || "Shipment Proof"}. ${proof.presentation.displayStatus}. View Proof`} disabled={app.busy} onPress={() => void home.openProof(proof)} style={[styles.record, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text style={[styles.recordTitle, { color: colors.textPrimary }]}>{proof.transaction.itemTitle || "Shipment Proof"}</Text><Text style={[styles.body, { color: colors.textSecondary }]}>{proof.presentation.displayStatus}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>Updated {formatDate(proof.updatedAt)}</Text>
        </PressableScale>)}
        {!home.loading && !home.recent.length ? <Text style={[styles.body, { color: colors.textSecondary }]}>{home.attention.length ? "Your other recent Proofs will appear here." : "Record the item, packing, seal and label in one continuous video. Your Proofs will appear here."}</Text> : null}
      </View></TutorialTarget>
    </View>
  </AppScreen>;
}
const styles = StyleSheet.create({ primaryAction: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 10, justifyContent: "center", alignItems: "center" }, content: { paddingHorizontal: 16, paddingTop: 8, gap: 14 }, next: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 }, state: { ...typography.secondaryStrong, fontSize: 12, lineHeight: 18 }, actionTitle: { ...typography.sectionTitle, fontSize: 22, lineHeight: 29 }, body: { ...typography.secondary, fontSize: 14, lineHeight: 21 }, meta: { ...typography.finePrint, fontSize: 12, lineHeight: 18 }, metrics: { flexDirection: "row", gap: 6 }, metric: { borderWidth: 1, borderRadius: 10, minHeight: 96, paddingHorizontal: 8, paddingVertical: 10, gap: 4 }, metricValue: { ...typography.sectionTitle, fontSize: 22, lineHeight: 28 }, metricLabel: { ...typography.secondaryStrong, fontSize: 12, lineHeight: 18 }, metricDetail: { ...typography.finePrint, fontSize: 11, lineHeight: 17 }, section: { gap: 10 }, sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, heading: { ...typography.bodyStrong, fontSize: 17, lineHeight: 24, flexShrink: 1 }, record: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 5, minHeight: 72 }, recordTitle: { ...typography.bodyStrong, fontSize: 15, lineHeight: 22 }, placeholder: { gap: 12, minHeight: 172 }, line: { height: 18, borderRadius: 5 }, titleLine: { height: 29, borderRadius: 5, width: "80%" }, buttonPlaceholder: { height: 48, borderRadius: 8, marginTop: 12 } });
