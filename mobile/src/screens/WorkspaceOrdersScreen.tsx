import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatUserFacingError } from "../copy/errors";
import { formatDate } from "../copy/format";
import { matchesOrderQuery, orderPresentation } from "../copy/orders";
import { ReadyOrders } from "../intake/ReadyOrders";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { EmptyState, ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { PressableScale } from "../ui/motion";
import { WorkspaceHeader } from "../ui/WorkspaceHeader";
import type { FulfillmentQueueItem } from "../v2-api";
import { MOBILE_TASK_UX_ENABLED } from "../experience/mobile-ux";

type OrderFilter = "ready" | "started" | "completed" | "all";

/** The workspace selector delegates every capture decision to openOrder's fresh server read. */
export function WorkspaceOrdersScreen({ station = false }: { station?: boolean }) {
  const app = usePackProof();
  const { colors } = useTheme();
  const taskPack = MOBILE_TASK_UX_ENABLED && station;
  const scope = `${app.apiBaseUrl}:${app.session?.userId ?? ""}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState(() => app.readOrdersView(station).query);
  const [filter, setFilter] = useState<OrderFilter>("ready");
  const [preparedProofIds, setPreparedProofIds] = useState<string[]>([]);
  const [queue, setQueue] = useState<{ scope: string; items: FulfillmentQueueItem[]; loading: boolean; error: string | null }>({ scope, items: [], loading: true, error: null });
  const freshScope = queue.scope === scope;
  const items = freshScope ? queue.items : [];
  const loading = !freshScope || queue.loading;
  const error = freshScope ? queue.error : null;
  const finalizedProofIds = new Set(app.proofCollection.filter(proof => proof.status === "FINALIZED").map(proof => proof.proofId));
  const pendingProofIds = new Set([...app.savedRecordings, ...(app.localCapture ? [app.localCapture] : [])]
    .filter(capture => !["FINALIZED", "SUBMITTED"].includes(capture.recovery?.phase ?? ""))
    .map(capture => capture.captureProofId).filter(Boolean));
  const presentOrder = (order: FulfillmentQueueItem) => {
    // Finalization is immutable. A retained original never makes finalized work recordable again.
    const canonical = orderPresentation(finalizedProofIds.has(order.proofId) ? { ...order, proofStatus: "FINALIZED" } : order);
    return canonical.state !== "excluded" && pendingProofIds.has(order.proofId)
      ? { state: "attention" as const, label: "Saved recording", action: "Open uploads" }
      : canonical;
  };

  useEffect(() => { setPreparedProofIds([]); }, [scope]);

  useEffect(() => {
    let alive = true;
    const userId = app.session?.userId;
    setQueue(previous => ({ scope, items: previous.scope === scope ? previous.items : [], loading: true, error: null }));
    if (!userId) {
      setQueue({ scope, items: [], loading: false, error: null });
      return () => { alive = false; };
    }
    void app.ensureAuth().then(() => {
      app.client.assertCaptureAccount(userId, app.apiBaseUrl);
      return app.client.listFulfillmentQueue("all");
    }).then(result => {
      if (alive && currentScope.current === scope) {
        app.client.assertCaptureAccount(userId, app.apiBaseUrl);
        setQueue({ scope, items: result.items, loading: false, error: null });
      }
    }).catch(reason => {
      if (alive && currentScope.current === scope) setQueue(previous => ({ ...previous, loading: false, error: formatUserFacingError(reason) }));
    });
    return () => { alive = false; };
  }, [scope, app.client, refresh]);

  const rows = items.filter(order => {
    if (preparedProofIds.includes(order.proofId)) return false;
    const state = presentOrder(order);
    if (filter === "ready" && state.state !== "ready") return false;
    if (filter === "started" && state.state !== "attention") return false;
    if (filter === "completed" && order.proofStatus !== "FINALIZED" && !finalizedProofIds.has(order.proofId)) return false;
    return matchesOrderQuery(query, [order.externalReference, order.externalOrderId, order.itemSummary, order.providerDisplay]);
  });
  const refreshQueue = () => { app.setError(null); setRefresh(value => value + 1); };
  const busy = app.busy || ["capturing", "preparing", "uploading"].includes(app.captureStatus);

  return <AppScreen key={scope} bottomInset={!MOBILE_TASK_UX_ENABLED} onRefresh={refreshQueue} refreshing={loading} initialOffsetY={app.readOrdersView(station).offsetY} restorationReady={!loading} onScrollOffset={offsetY => app.saveOrdersView(station, { offsetY })} resetScrollKey={`${filter}:${query}`}>
    <WorkspaceHeader section={taskPack ? "Pack" : station ? "Packing Station" : "Orders"} />
    <View style={styles.heading}>{!MOBILE_TASK_UX_ENABLED ? <Text style={[styles.eyebrow, { color: colors.textMuted }]}>{station ? "Fulfillment capture" : "Your workspace"}</Text> : null}<Text accessibilityRole="header" style={[styles.title, MOBILE_TASK_UX_ENABLED && styles.mobileTitle, { color: colors.textPrimary }]}>{taskPack ? "Pack" : station ? "Packing Station" : "Orders"}</Text><Text style={[styles.copy, { color: colors.textSecondary }]}>{taskPack ? "Choose a shipment to record." : station ? "Select a shipment. Record its packing. Review and confirm." : "Synchronized orders, ready for the packing table."}</Text></View>
    {taskPack ? <View style={styles.entrances}>
      <Button label="Scan shipment" icon="scan-outline" disabled={busy} onPress={() => { app.setScanPhase("camera"); app.setScanInput(""); app.go("scan"); }} />
      <Button label="Select existing Proof" icon="document-text-outline" variant="secondary" disabled={busy} onPress={() => { app.setProofsView("all"); app.setProofsQuery(""); app.go("proofs"); }} />
      <Button label="Create new Proof" icon="add-outline" variant="secondary" disabled={busy} onPress={() => app.go("create")} />
      <Button label="View Orders" variant="tertiary" onPress={() => app.go("orders")} />
    </View> : <View style={styles.actions}><View style={styles.action}><Button label="Create Proof" icon="add-outline" disabled={busy} onPress={() => app.go("create")} /></View><View style={styles.action}><Button label="Refresh" icon="refresh-outline" variant="secondary" disabled={busy || loading} onPress={refreshQueue} /></View></View>}
    <OfflineBanner visible={app.offline} /><ErrorBanner message={app.error || error} />
    {station && !taskPack ? <View style={[styles.stationNotice, { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder }]}><Ionicons name="videocam-outline" size={27} color={colors.accentText} /><View style={styles.noticeCopy}><Text style={[styles.cardTitle, { color: colors.textPrimary }]}>Ready at the packing table</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>The camera opens after you select a shipment. Existing recordings remain available in Uploads.</Text></View></View> : null}
    {taskPack ? <Text accessibilityRole="header" style={[styles.cardTitle, { color: colors.textPrimary }]}>Shipment queue</Text> : null}
    <View style={styles.tabs} accessibilityRole="tablist" accessibilityLabel="Order filters">{([["ready", "Needs fulfillment"], ["started", "Needs attention"], ["completed", "Completed"], ["all", "All orders"]] as const).map(([value, label]) => <PressableScale key={value} accessibilityRole="tab" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={[styles.tab, { backgroundColor: filter === value ? colors.accentSoft : "transparent" }]}><Text style={[styles.tabLabel, { color: filter === value ? colors.accentText : colors.textSecondary }]}>{label}</Text></PressableScale>)}</View>
    <View style={[styles.search, { borderColor: colors.controlBorder, backgroundColor: colors.surface }]}><Ionicons name="search-outline" size={19} color={colors.textMuted} /><TextInput accessibilityLabel="Search orders" placeholder="Search order, item, or marketplace…" placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} value={query} onChangeText={value => { setQuery(value); app.saveOrdersView(station, { query: value, offsetY: 0 }); }} style={[styles.searchInput, { color: colors.textPrimary }]} /></View>
    {!query.trim() && (filter === "ready" || filter === "all") ? <ReadyOrders onPreparedProofsChange={setPreparedProofIds} /> : null}
    {loading ? <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>Loading orders…</Text> : null}
    {!loading && error ? <Button label="Try loading orders again" variant="secondary" onPress={refreshQueue} /> : null}
    {!error && rows.map(order => {
      const state = presentOrder(order);
      const completed = order.proofStatus === "FINALIZED" || finalizedProofIds.has(order.proofId);
      const savedRecording = !completed && pendingProofIds.has(order.proofId);
      const label = completed ? "Completed" : order.workflowState === "REMOVED_FROM_FULFILLMENT" ? "Removed from fulfillment" : state.label || "View Proof";
      return <View key={order.proofId} style={[styles.orderCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><PressableScale accessibilityRole="button" accessibilityLabel={`Open ${order.itemSummary} Proof`} disabled={busy} onPress={() => void app.run(() => app.openProof(order.proofId))} style={styles.orderHeading}><View style={styles.noticeCopy}><Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{order.externalReference || order.externalOrderId}</Text><Text style={[styles.copy, { color: colors.textSecondary }]}>{order.itemSummary}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.textMuted} /></PressableScale><View style={styles.metadata}><Text style={[styles.badge, { backgroundColor: completed ? colors.successSoft : state.state === "ready" ? colors.accentSoft : colors.surfaceElevated, color: completed ? colors.successText : state.state === "ready" ? colors.accentText : colors.textSecondary }]}>{label}</Text><Text style={[styles.meta, { color: colors.textSecondary }]}>{order.providerDisplay}{order.orderedAt ? ` · ${formatDate(order.orderedAt)}` : ""}</Text></View><Button label={savedRecording ? "Open saved recording" : state.state === "ready" ? "Open camera preview" : "View Proof"} icon={savedRecording ? "cloud-upload-outline" : state.state === "ready" ? "videocam-outline" : "document-text-outline"} variant={state.state === "ready" ? "primary" : "secondary"} disabled={busy} onPress={() => savedRecording ? (MOBILE_TASK_UX_ENABLED ? app.go("activity", { activityFilter: "attention" }) : app.go("account", { accountSection: "recordings" })) : state.state === "ready" ? void app.openOrder(order.proofId, station) : void app.run(() => app.openProof(order.proofId))} /></View>;
    })}
    {!loading && !error && !rows.length && !preparedProofIds.length ? <EmptyState title={query.trim() ? "No matching orders" : "No orders in this view"} body={query.trim() ? "Try a different order reference, item, or marketplace." : taskPack ? "You can create a Proof for any shipment. Connecting a marketplace is optional." : "Orders from your connected marketplaces appear after synchronization."} actionLabel={query.trim() ? "Clear search" : taskPack ? "Create new Proof" : "Manage integrations"} onAction={() => { if (query.trim()) { setQuery(""); app.saveOrdersView(station, { query: "", offsetY: 0 }); } else if (taskPack) app.go("create"); else app.go("account", { accountSection: "channels" }); }} /> : null}
  </AppScreen>;
}

const styles = StyleSheet.create({
  mobileTitle: { fontSize: 24, lineHeight: 31 }, entrances: { gap: 10 },
  heading: { gap: 8 }, eyebrow: { fontSize: 10, lineHeight: 15, fontWeight: "700", letterSpacing: 1.5, textTransform: "uppercase" }, title: { ...typography.pageTitle }, copy: { ...typography.body }, meta: { ...typography.secondary }, cardTitle: { ...typography.bodyStrong, fontSize: 16, lineHeight: 23 },
  actions: { flexDirection: "row", gap: 12 }, action: { flex: 1 }, tabs: { flexDirection: "row", flexWrap: "wrap", flexGrow: 0, flexShrink: 0, gap: 5 }, tab: { minHeight: 48, justifyContent: "center", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 6 }, tabLabel: { ...typography.secondaryStrong },
  search: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 9, borderWidth: 1, borderRadius: 8, minHeight: 48 }, searchInput: { flex: 1, ...typography.body, paddingVertical: 12 },
  stationNotice: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20, borderWidth: 1, borderRadius: 10 }, noticeCopy: { flex: 1, gap: 6 }, orderCard: { padding: 18, gap: 15, borderWidth: 1, borderRadius: 10 }, orderHeading: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 }, metadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }, badge: { ...typography.caption, fontWeight: "600", borderRadius: 5, paddingHorizontal: 8, paddingVertical: 5 },
});
