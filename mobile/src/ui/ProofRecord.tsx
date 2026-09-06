import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { motion } from "../theme/motion";
import { typography } from "../theme/tokens";
import { formatDateTime, orderReferenceLabel } from "../copy/format";
import { originalBookmarks, receiptAcknowledgment, type ProofRecordTab, type ReceiptRecordSummary } from "../copy/proof-record";
import { type EvidenceAnchor, type SignatureView } from "../signature";
import { isGradingWorkflow } from "../copy/custody";
import { StatusBadge, statusTone } from "./StatusBadge";
import { Button } from "./Button";
import { PressableScale } from "./motion";
import { ProofEvidencePreview } from "./ProofEvidencePreview";
import { ProofRecordTimeline } from "./ProofRecordTimeline";
import { ProofTrackingPanel } from "./ProofTrackingPanel";

const tabs: ProofRecordTab[] = ["Evidence", "Timeline", "Tracking", "Receipt"];

export function ProofRecord({ statusLabel, summaryLine, action, supplementary }: {
  statusLabel: string;
  summaryLine?: string;
  action: ReactNode;
  supplementary?: ReactNode;
}) {
  const app = usePackProof(), { colors, reducedMotion } = useTheme();
  const proof = app.proof!, txn = app.transactionDetail ?? proof.transaction;
  const saved = useRef(app.readProofRecordView(proof.proofId));
  const [tab, setTab] = useState(saved.current.tab), [filter, setFilter] = useState(saved.current.timelineFilter);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(saved.current.selectedEvidenceId ?? null);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(saved.current.selectedShipmentId ?? null);
  const [anchors, setAnchors] = useState<EvidenceAnchor[]>([]), [bookmarkError, setBookmarkError] = useState(false);
  const [bookmarksLoading, setBookmarksLoading] = useState(true);
  const [receipt, setReceipt] = useState<ReceiptRecordSummary | null>(null), [receiptError, setReceiptError] = useState<string | null>(null), [receiptLoading, setReceiptLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const scroll = useRef<ScrollView>(null), pendingOffset = useRef<number | null>(saved.current.offsets[tab]);
  const contentHeight = useRef(0), viewportHeight = useRef(0);
  const tabScroll = useRef<ScrollView>(null), tabPositions = useRef<Record<string, number>>({});
  const fade = useRef(new Animated.Value(1)).current;
  const committed = proof.evidence.filter(item => item.validationStatus === "COMMITTED");
  const selectedEvidence = committed.find(item => item.evidenceId === selectedEvidenceId) ?? committed.find(item => item.contentType?.startsWith("video/")) ?? committed[0];
  const grading = isGradingWorkflow(proof.workflowType);
  const receiptReady = !grading && proof.status === "FINALIZED";
  const hasVideo = committed.some(item => item.contentType?.startsWith("video/"));
  const client = app.client;

  useEffect(() => {
    let current = true;
    setBookmarkError(false);
    setBookmarksLoading(hasVideo);
    if (!hasVideo) { setAnchors([]); return; }
    void (async () => {
      await app.ensureAuth();
      const view = await client.signatureRequest<SignatureView>(proof.proofId);
      if (current) setAnchors(view.snapshot.data.anchors);
    })().catch(() => { if (current) setBookmarkError(true); }).finally(() => { if (current) setBookmarksLoading(false); });
    return () => { current = false; };
  }, [client, proof.proofId, proof.version, hasVideo, reload]);

  useEffect(() => {
    if (tab !== "Receipt" || !receiptReady) return;
    let current = true;
    setReceiptLoading(true); setReceiptError(null);
    void (async () => {
      await app.ensureAuth();
      const next = await client.lifecycleRequest<ReceiptRecordSummary>(proof.proofId, "");
      if (current) setReceipt(next);
    })().catch(() => {
      if (current) setReceiptError("Receipt details could not be loaded. Refresh to try again.");
    }).finally(() => { if (current) setReceiptLoading(false); });
    return () => { current = false; };
  }, [client, proof.proofId, proof.version, receiptReady, tab, reload]);

  function saveOffset(offset: number) {
    if (pendingOffset.current !== null) return;
    // Native scroll events only update this presentation ref, avoiding render work during a fling.
    saved.current = { ...saved.current, offsets: { ...saved.current.offsets, [tab]: Math.max(0, offset) } };
    app.saveProofRecordView(proof.proofId, saved.current);
  }
  function selectTab(next: ProofRecordTab) {
    if (next === tab) return;
    pendingOffset.current = saved.current.offsets[next];
    contentHeight.current = 0;
    saved.current = { ...saved.current, tab: next };
    app.saveProofRecordView(proof.proofId, saved.current);
    setTab(next);
    tabScroll.current?.scrollTo({ x: Math.max(0, (tabPositions.current[next] ?? 0) - 12), animated: !reducedMotion });
    fade.stopAnimation(); fade.setValue(reducedMotion ? 1 : 0.5);
    Animated.timing(fade, { toValue: 1, duration: reducedMotion ? 0 : motion.duration.fast, useNativeDriver: true }).start();
  }
  function selectEvidence(evidenceId: string) {
    saved.current = { ...saved.current, selectedEvidenceId: evidenceId };
    app.saveProofRecordView(proof.proofId, saved.current);
    setSelectedEvidenceId(evidenceId);
  }
  function savePlayback(evidenceId: string, seconds: number) {
    saved.current = { ...saved.current, playbackTimes: { ...saved.current.playbackTimes, [evidenceId]: seconds } };
    app.saveProofRecordView(proof.proofId, saved.current);
  }
  function selectShipment(id: string) {
    saved.current = { ...saved.current, selectedShipmentId: id };
    app.saveProofRecordView(proof.proofId, saved.current);
    setSelectedShipmentId(id);
  }
  function selectFilter(next: string) {
    saved.current = { ...saved.current, timelineFilter: next, offsets: { ...saved.current.offsets, Timeline: 0 } };
    app.saveProofRecordView(proof.proofId, saved.current);
    setFilter(next); scroll.current?.scrollTo({ y: 0, animated: !reducedMotion });
  }
  function restoreOffset() {
    if (pendingOffset.current === null || contentHeight.current <= 0 || viewportHeight.current <= 0) return;
    const waiting = tab === "Receipt" && receiptReady && (receiptLoading || (!receipt && !receiptError)) || tab === "Evidence" && hasVideo && bookmarksLoading;
    if (pendingOffset.current > 0 && waiting) return;
    const offset = Math.min(pendingOffset.current, Math.max(0, contentHeight.current - viewportHeight.current));
    pendingOffset.current = null;
    scroll.current?.scrollTo({ y: offset, animated: false });
  }
  useEffect(() => { restoreOffset(); }, [tab, receiptLoading, receipt, receiptError, bookmarksLoading]);
  function refresh() {
    void app.run(async () => {
      await app.refreshProof(proof.proofId);
      setReload(value => value + 1);
    });
  }
  const shipping = proof.shipmentObservations?.identity ?? txn.shipping;
  const reports = proof.shipmentObservations?.events ?? [];
  const carrierReport = [...reports].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const receiptStage = receipt?.stages.find(stage => stage.type === "RECEIPT");

  return <View style={[styles.record, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <View style={[styles.top, { borderBottomColor: colors.divider }]}>
      <View style={styles.identity}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{[txn.itemTitle || "Your item", txn.externalReference ? orderReferenceLabel(txn.externalReference) : null].filter(Boolean).join(" · ")}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{summaryLine || "Your transaction-bound evidence record"}</Text>
      </View>
      <StatusBadge label={statusLabel} tone={statusTone(statusLabel)} />
    </View>
    <View style={[styles.tabBorder, { borderBottomColor: colors.divider }]}>
      <ScrollView ref={tabScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist" accessibilityLabel="Proof record views">
        {tabs.map(label => <View key={label} onLayout={event => { tabPositions.current[label] = event.nativeEvent.layout.x; if (tab === label) tabScroll.current?.scrollTo({ x: Math.max(0, event.nativeEvent.layout.x - 12), animated: false }); }}><PressableScale accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: tab === label }} onPress={() => selectTab(label)} style={[styles.tab, { borderBottomColor: tab === label ? colors.accent : "transparent" }]}>
          <Text style={[styles.tabLabel, { color: tab === label ? colors.accentText : colors.textSecondary }]}>{label}</Text>
        </PressableScale></View>)}
      </ScrollView>
    </View>
    <Animated.View style={[styles.panel, { opacity: fade }]}>
      <ScrollView key={tab} ref={scroll} contentContainerStyle={styles.body} contentOffset={{ x: 0, y: saved.current.offsets[tab] }} onLayout={event => { viewportHeight.current = event.nativeEvent.layout.height; restoreOffset(); }} onContentSizeChange={(_width, height) => { contentHeight.current = height; restoreOffset(); }} onScroll={event => saveOffset(event.nativeEvent.contentOffset.y)} scrollEventThrottle={32} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={<RefreshControl refreshing={app.busy} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}>
        {tab === "Evidence" ? <>
          {!committed.length ? <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.accentSoft }]}><Ionicons name="videocam-outline" size={30} color={colors.accentText} /></View>
            <Text style={[styles.heading, { color: colors.textPrimary }]}>Your evidence belongs here.</Text>
            <Text style={[styles.text, { color: colors.textSecondary }]}>Record the item, packing, seal, and shipping label. Saved original evidence will appear in this record.</Text>
          </View> : <>
            {committed.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectors} accessibilityLabel="Choose original evidence">{committed.map((item, index) => <PressableScale key={item.evidenceId} onPress={() => selectEvidence(item.evidenceId)} accessibilityRole="button" accessibilityState={{ selected: selectedEvidence?.evidenceId === item.evidenceId }} style={[styles.selector, { backgroundColor: selectedEvidence?.evidenceId === item.evidenceId ? colors.accentSoft : colors.surface, borderColor: selectedEvidence?.evidenceId === item.evidenceId ? colors.accentSoftBorder : colors.border }]}><Text style={[styles.subtitle, { color: colors.textPrimary }]}>{item.contentType?.startsWith("video/") ? "Video" : item.contentType?.startsWith("image/") ? "Image" : "File"} {index + 1}</Text></PressableScale>)}</ScrollView> : null}
            {selectedEvidence ? <ProofEvidencePreview key={selectedEvidence.evidenceId} evidence={selectedEvidence} title={selectedEvidence.contentType?.startsWith("video/") ? `Recording · ${txn.itemTitle || "Your item"}` : `Evidence · ${txn.itemTitle || "Your item"}`} bookmarks={originalBookmarks(selectedEvidence, anchors)} initialTime={saved.current.playbackTimes?.[selectedEvidence.evidenceId] ?? 0} onTime={seconds => savePlayback(selectedEvidence.evidenceId, seconds)} labelOffsetMs={proof.captureShipping?.observations.find(item => item.evidenceId === selectedEvidence.evidenceId)?.detectedAtMs} /> : null}
            {bookmarkError ? <Text style={[styles.note, { color: colors.textSecondary }]}>Saved bookmarks could not be loaded. Pull down to refresh; the original recording remains available.</Text> : null}
          </>}
          {action}
          {proof.evidence.some(item => item.validationStatus === "PENDING") ? <Text style={[styles.note, { color: colors.textSecondary }]}>An upload is still pending. It appears as original evidence after the server commits it.</Text> : null}
          <Button label="Replay, ask, or build a case packet" variant="secondary" onPress={() => app.go("signature")} />
          {supplementary}
        </> : null}
        {tab === "Timeline" ? <ProofRecordTimeline entries={proof.chronology ?? []} finalizedAt={proof.finalizedAt} filter={filter} onFilter={selectFilter} onSelect={entry => { app.setSelectedEvent(entry); app.go("event"); }} /> : null}
        {tab === "Tracking" ? <>
          <ProofTrackingPanel events={reports} carrier={shipping?.carrier} trackingNumber={shipping?.trackingNumber} selectedId={selectedShipmentId} onSelect={selectShipment} />
          {proof.captureShipping ? <View style={[styles.info, { borderColor: colors.border }]}>
            <Text style={[styles.eyebrow, { color: colors.accentText }]}>SHIPPING LABEL</Text>
            <Text style={[styles.text, { color: colors.textPrimary }]}>{proof.captureShipping.observations[0]?.trackingNumber || "Label scan saved"}</Text>
            <Text style={[styles.note, { color: colors.textSecondary }]}>Captured during packing at {Math.floor((proof.captureShipping.observations[0]?.detectedAtMs ?? 0) / 1000)}s · reported by this device</Text>
            <Text style={[styles.note, { color: colors.textSecondary }]}>{proof.captureShipping.registration.mode === "test" ? "Test tracking data · " : ""}{proof.captureShipping.registration.state === "REGISTERED" ? `${proof.captureShipping.registration.carrier ?? "Carrier"} tracking connected` : proof.captureShipping.registration.errorCode === "SHIPPO_TEST_TRACKING_ONLY" ? "Tracking number attached · live Shippo access needed for this package" : proof.captureShipping.registration.errorCode === "SHIPMENT_CARRIER_REQUIRED" ? "Tracking number attached · choose a carrier in shipping information" : proof.captureShipping.registration.state === "WAITING_FOR_CONNECTION" ? "Tracking number attached · carrier connection needed" : proof.captureShipping.registration.state === "FAILED" ? "Tracking number attached · carrier lookup needs attention" : "Tracking number attached · carrier update pending"}</Text>
          </View> : null}
          {proof.shipmentSync?.available ? <Button label="Update tracking" variant="secondary" loading={app.busy} onPress={() => void app.syncShipment()} /> : null}
          {!grading && app.role === "SELLER" && proof.status !== "FINALIZED" ? <Button label="Edit shipping information" variant="secondary" onPress={() => app.go("editShipping")} /> : null}
        </> : null}
        {tab === "Receipt" ? <View style={styles.receipt}>
          <Text style={[styles.eyebrow, { color: colors.textSecondary }]}>BUYER RECEIPT</Text>
          <Text style={[styles.receiptTitle, { color: colors.textPrimary }]}>Your shipment record</Text>
          <Text style={[styles.text, { color: colors.textSecondary }]}>Review the order and original evidence, then document receipt or a return when it is your turn.</Text>
          <View style={styles.receiptDetails}>
            <ReceiptDetail label="Order" value={[txn.itemTitle || "Item details not provided", txn.externalReference ? orderReferenceLabel(txn.externalReference) : null].filter(Boolean).join(" · ")} />
            <ReceiptDetail label="Carrier report" value={carrierReport ? `${carrierReport.eventType.toLowerCase().replace(/_/g, " ")}${carrierReport.eventData.test === true ? " · test tracking data" : ""}` : "Not recorded"} />
            {carrierReport ? <ReceiptDetail label="Report source" value={[carrierReport.provider, carrierReport.source, formatDateTime(carrierReport.occurredAt)].filter(Boolean).join(" · ")} /> : null}
            <ReceiptDetail label="Buyer acknowledgment" value={grading ? "Managed through this custody workflow" : !receiptReady ? "Available after the packing Proof is finalized" : receiptLoading ? "Loading receipt record…" : receiptError ? "Unavailable · refresh to check" : receiptAcknowledgment(receipt)} />
            {receiptStage?.finalizedAt ? <ReceiptDetail label="Receipt recorded" value={formatDateTime(receiptStage.finalizedAt)} /> : null}
          </View>
          {receiptError ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.error }]}>{receiptError}</Text> : null}
          <Button label="Review the original evidence" variant="secondary" onPress={() => selectTab("Evidence")} />
          {receiptReady && (app.role === "SELLER" || app.role === "BUYER") ? <Button label={app.role === "SELLER" ? "Manage receipt and returns" : "Document receipt or return"} variant="secondary" onPress={() => app.openReceipt(proof.proofId)} /> : null}
          {grading ? <Button label="View custody progress" variant="secondary" onPress={() => selectTab("Timeline")} /> : null}
          <Text style={[styles.text, { color: colors.textSecondary }]}>Viewing a receipt does not acknowledge delivery, accept an item’s condition, or waive a return.</Text>
          <Text style={[styles.note, { color: colors.textSecondary }]}>Receipt and return recordings are appended separately. The finalized packing record stays preserved.</Text>
        </View> : null}
      </ScrollView>
    </Animated.View>
  </View>;
}

function ReceiptDetail({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return <View style={styles.receiptDetail}><Text style={[styles.text, { color: colors.textSecondary }]}>{label}</Text><Text style={[styles.text, { color: colors.textPrimary, paddingLeft: 20 }]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  record: { flex: 1, minHeight: 0, borderWidth: 1, borderRadius: 20, overflow: "hidden" },
  top: { padding: 18, gap: 12, borderBottomWidth: 1 }, identity: { gap: 6 }, title: { ...typography.bodyStrong, fontSize: 18, lineHeight: 25 },
  subtitle: { ...typography.secondary }, tabBorder: { borderBottomWidth: 1 }, tabs: { paddingHorizontal: 12, gap: 12, flexGrow: 1 },
  tab: { minWidth: 74, minHeight: 56, paddingHorizontal: 7, paddingTop: 17, paddingBottom: 13, borderBottomWidth: 3, alignItems: "center", justifyContent: "center" }, tabLabel: { ...typography.secondary },
  panel: { flex: 1, minHeight: 0 }, body: { padding: 14, paddingTop: 20, paddingBottom: 28, gap: 20 },
  text: { ...typography.body }, note: { ...typography.secondary }, heading: { ...typography.sectionTitle },
  empty: { gap: 12, paddingVertical: 12 }, emptyIcon: { width: 58, height: 58, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  selectors: { gap: 8 }, selector: { minHeight: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  info: { padding: 16, borderWidth: 1, borderRadius: 14, gap: 10 }, eyebrow: { ...typography.caption, letterSpacing: 1.3, fontWeight: "700" },
  receipt: { gap: 24 }, receiptTitle: { ...typography.pageTitle }, receiptDetails: { gap: 18, paddingVertical: 8 }, receiptDetail: { gap: 6 },
});
