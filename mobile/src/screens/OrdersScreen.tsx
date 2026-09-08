import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import type { FulfillmentQueueItem, ProofCollectionItem } from "../v2-api";
import { captureRecoveryLabel } from "../capture/recovery-model";
import { EMPTY_FORM } from "../copy/forms";
import { formatDateTime, moneyLabel } from "../copy/format";
import { classifyOrders, matchesOrderQuery, orderChannelNotice, orderPresentation } from "../copy/orders";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { PressableScale } from "../ui/motion";

export function OrdersScreen({ batch = false }: { batch?: boolean }) {
  const app = usePackProof(), { colors } = useTheme();
  const initialView = useRef(app.readOrdersView(batch)).current;
  const [items, setItems] = useState<FulfillmentQueueItem[]>([]);
  const [loading, setLoading] = useState(true), [queueLoaded, setQueueLoaded] = useState(false);
  const [query, setQuery] = useState(initialView.query);
  const [error, setError] = useState<string | null>(null);
  const scope = `${app.apiBaseUrl}:${app.session?.userId}`;
  const generation = useRef(0);
  async function refresh() {
    const attempt = ++generation.current;
    setLoading(true); setError(null);
    try {
      await app.ensureAuth();
      const [queue] = await Promise.all([app.client.listFulfillmentQueue("all"), app.syncWorkspace()]);
      if (generation.current === attempt) { setItems(queue.items); setQueueLoaded(true); }
    } catch {
      if (generation.current === attempt) setError("Orders couldn’t refresh. Check your connection and try again. Your existing Proofs are still available.");
    } finally { if (generation.current === attempt) setLoading(false); }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current();
    const wake = AppState.addEventListener("change", state => { if (state === "active") void refreshRef.current(); });
    return () => { generation.current++; wake.remove(); };
  }, [scope]);

  const connected = app.connections.length > 0 || app.connectedAccounts.some(account => account.status !== "DISCONNECTED"
    && (account.capabilities.transactions || account.capabilities.fulfillment));
  const pending = app.savedRecordings.filter(capture => capture.recovery?.phase !== "FINALIZED" && capture.recovery?.phase !== "SUBMITTED");
  const localPending = app.localCapture && !["FINALIZED", "SUBMITTED"].includes(app.localCapture.recovery?.phase ?? "");
  const extraLocal = localPending && !pending.some(capture => capture.uri === app.localCapture?.uri) ? app.localCapture : null;
  const pendingProofIds = [...pending.map(capture => capture.captureProofId), extraLocal?.captureProofId].filter((id): id is string => Boolean(id));
  const lists = classifyOrders({ allQueue: items, queueLoaded, proofs: app.proofCollection, pendingProofIds });
  const summaries = new Map(app.proofCollection.map(item => [item.proofId, item]));
  const matchesQueue = (item: FulfillmentQueueItem) => matchesOrderQuery(query, [item.itemSummary, item.externalReference, item.externalOrderId, item.providerDisplay, summaries.get(item.proofId)?.transaction.trackingNumber]);
  const matchesDraft = (item: ProofCollectionItem) => matchesOrderQuery(query, [item.transaction.itemTitle, item.transaction.externalReference, item.transaction.trackingNumber]);
  const ready = lists.ready.filter(matchesQueue), attention = lists.attention.filter(matchesQueue);
  const readyDrafts = lists.drafts.filter(item => item.status === "READY_FOR_EVIDENCE" && matchesDraft(item));
  const attentionDrafts = lists.drafts.filter(item => item.status !== "READY_FOR_EVIDENCE" && matchesDraft(item));
  const notice = orderChannelNotice(app.connections);
  const latestSync = app.connections.filter(connection => connection.lastSyncAt && Number.isFinite(Date.parse(connection.lastSyncAt)))
    .sort((left, right) => Date.parse(right.lastSyncAt!) - Date.parse(left.lastSyncAt!))[0];
  const hasWork = pending.length > 0 || Boolean(extraLocal) || lists.ready.length + lists.attention.length + lists.drafts.length > 0;
  const hasResults = ready.length + attention.length + readyDrafts.length + attentionDrafts.length > 0;
  const hasQuery = Boolean(query.trim());
  const setSearch = (value: string) => { setQuery(value); app.saveOrdersView(batch, { query: value }); };
  const startManual = () => { app.clearIntakeReview(); app.setCreateForm({ ...EMPTY_FORM }); app.go("create"); };
  const openChannels = () => app.go("account", { accountSection: "channels" });
  const titleFor = (proofId: string | null | undefined) => proofId ? summaries.get(proofId)?.transaction.itemTitle
    || (app.proof?.proofId === proofId ? app.proof.transaction.itemTitle : null) || "Saved recording" : "Saved recording";

  function queueRow(item: FulfillmentQueueItem, next = false) {
    const model = orderPresentation(item);
    return <OrderRow key={item.proofId} title={item.itemSummary || "Shipment"}
      detail={[item.providerDisplay, item.externalReference || item.externalOrderId ? `Order ${(item.externalReference || item.externalOrderId).slice(-16)}` : "", moneyLabel(item.transactionValue, item.currency)].filter(Boolean).join(" · ")}
      status={model.label} action={model.action} next={next} disabled={app.busy}
      onPress={() => void app.openOrder(item.proofId, batch)} />;
  }
  function draftRow(item: ProofCollectionItem, next = false) {
    const ready = item.status === "READY_FOR_EVIDENCE";
    return <OrderRow key={item.proofId} title={item.transaction.itemTitle || "Shipment"}
      detail={["Shipment setup", item.transaction.externalReference ? `Order ${item.transaction.externalReference.slice(-16)}` : ""].filter(Boolean).join(" · ")}
      status={ready ? "Continue recording setup" : item.status === "EVIDENCE_COMMITTED" ? "Finish your Proof" : "Review order setup"}
      action={ready ? "Open camera preview" : "Open Proof"} next={next} disabled={app.busy}
      onPress={() => void app.openOrder(item.proofId, batch)} />;
  }

  return <AppScreen onRefresh={() => void refresh()} refreshing={loading} extraBottom={24} bottomInset={batch}
    initialOffsetY={initialView.offsetY} restorationReady={queueLoaded}
    onScrollOffset={offsetY => app.saveOrdersView(batch, { offsetY })}>
    <AppHeader title={batch ? "Pack multiple orders" : "Orders"} onBack={batch ? () => app.go("orders") : undefined} />
    {batch ? <Text style={[typography.body, { color: colors.textSecondary }]}>Finish one package, then move to the next.</Text> : null}
    <OfflineBanner visible={app.offline} />
    <ErrorBanner message={error || app.error || (notice?.kind === "error" ? notice.message : null)} />
    {notice?.kind === "waiting" ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>{notice.message}</Text> : null}
    {notice?.kind === "error" ? <Button label="Review sales channels" variant="tertiary" onPress={openChannels} /> : null}

    {lists.ready.length + lists.attention.length + lists.drafts.length > 0 || hasQuery ? <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
      <TextInput value={query} onChangeText={setSearch} accessibilityLabel="Search orders" placeholder="Item, order, or tracking" placeholderTextColor={colors.textMuted}
        autoCapitalize="none" autoCorrect={false} style={[styles.searchInput, { color: colors.textPrimary }]} />
    </View> : null}

    {pending.length || extraLocal || attention.length || attentionDrafts.length ? <View style={styles.group}>
      <Text style={[typography.sectionTitle, { color: colors.textPrimary }]}>Needs attention</Text>
      {pending.map(capture => <OrderRow key={capture.uri} title={titleFor(capture.captureProofId)}
        detail={capture.recovery?.phase === "RECORDING" ? "The interrupted recording needs inspection." : capture.recovery ? captureRecoveryLabel(capture.recovery.phase) : "Saved on this device"}
        status="" action={capture.recovery?.phase === "RECORDING" ? "Check interrupted recording" : "Review recording"} disabled={app.busy}
        onPress={() => capture.recovery?.phase === "RECORDING" ? app.go("account", { accountSection: "recordings" }) : void app.resumeSavedCapture(capture)} />)}
      {extraLocal ? <OrderRow title={titleFor(extraLocal.captureProofId)} detail="Saved on this device" status="" action="Review recording" disabled={app.busy} onPress={() => {
        if (app.session?.stationActive) app.go("station");
        else if (extraLocal.captureProofId) void app.openOrder(extraLocal.captureProofId, batch);
      }} /> : null}
      {attention.map(item => queueRow(item))}
      {attentionDrafts.map(item => draftRow(item))}
    </View> : null}



    <Text style={[typography.sectionTitle, { color: colors.textPrimary }]}>Ready to pack</Text>
    {loading && !queueLoaded ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>Loading orders…</Text> : null}
    {ready.map((item, index) => queueRow(item, batch && index === 0))}
    {readyDrafts.map((item, index) => draftRow(item, batch && !ready.length && index === 0))}
    {queueLoaded && hasQuery && !hasResults ? <View style={styles.group}>
      <Text style={[typography.body, { color: colors.textPrimary }]}>No matching orders</Text>
      <Button label="Clear search" variant="tertiary" onPress={() => setSearch("")} />
    </View> : null}
    {queueLoaded && !hasQuery && hasWork && !ready.length && !readyDrafts.length ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>No new orders ready to pack.</Text> : null}
    {!loading && !hasWork && !hasQuery ? <View style={styles.group}>
      <Text style={[typography.body, { color: colors.textPrimary }]}>{error || notice?.kind === "error" ? "Order updates are unavailable" : notice ? "Waiting for order updates" : batch ? "You’re caught up" : connected ? "No orders ready to pack" : "Make a record of your next shipment"}</Text>
      <Text style={[typography.body, { color: colors.textSecondary }]}>Record the item as you pack and seal it. Show the shipping label in the same video.</Text>
      <Button label="Record shipment" onPress={startManual} disabled={Boolean(localPending) || app.busy} />
      {!connected ? <Button label="Connect a marketplace" variant="tertiary" onPress={openChannels} /> : null}
    </View> : queueLoaded && !hasQuery ? <Button label="Order not listed?" variant="tertiary" onPress={startManual} disabled={Boolean(localPending) || app.busy} /> : null}
    {localPending ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>Finish saving your current recording before starting another shipment.</Text> : null}
    {latestSync ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>Latest successful check: {latestSync.providerDisplay}, {formatDateTime(latestSync.lastSyncAt)}.</Text>
      : connected && queueLoaded ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>No successful channel order check yet.</Text> : null}
    {lists.ready.length + lists.drafts.filter(item => item.status === "READY_FOR_EVIDENCE").length > 1 && !batch ? <Button label="Pack multiple orders" variant="tertiary" onPress={() => app.go("station")} disabled={Boolean(localPending) || app.busy} /> : null}
    <Button label={loading ? "Refreshing…" : "Refresh orders"} variant="tertiary" disabled={loading} onPress={() => void refresh()} />
  </AppScreen>;
}

function OrderRow({ title, detail, status, action, onPress, disabled, next = false }: {
  title: string; detail: string; status: string; action: string; onPress: () => void; disabled?: boolean; next?: boolean;
}) {
  const { colors } = useTheme();
  return <PressableScale accessibilityRole="button" accessibilityLabel={`${title}. ${detail}. ${status}. ${action}`} accessibilityState={{ disabled: Boolean(disabled) }}
    disabled={disabled} onPress={onPress} style={[styles.row, { backgroundColor: colors.surface, borderColor: next ? colors.accent : colors.border }]}>
    <Ionicons name="cube-outline" size={24} color={colors.textSecondary} />
    <View style={styles.rowCopy}>
      {next ? <Text style={[typography.secondaryStrong, { color: colors.accent }]}>Next order</Text> : null}
      <Text style={[typography.cardTitle, { color: colors.textPrimary }]}>{title}</Text>
      {detail ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>{detail}</Text> : null}
      {status ? <Text style={[typography.secondary, { color: colors.textSecondary }]}>{status}</Text> : null}
    </View>
    <Ionicons name="chevron-forward" size={20} color={colors.accent} />
  </PressableScale>;
}
const styles = StyleSheet.create({
  group: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, minHeight: 80, borderWidth: 1, borderRadius: 12 },
  rowCopy: { flex: 1, gap: 4 },
  search: { minHeight: 48, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, ...typography.body, paddingVertical: 12 },
});
