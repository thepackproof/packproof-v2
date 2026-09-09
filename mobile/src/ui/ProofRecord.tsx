import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { motion } from "../theme/motion";
import { localProofWork, presentationForProof } from "../copy/proof-list";
import { typography } from "../theme/tokens";
import { formatDateTime } from "../copy/format";
import { committedRecordEvidence, originalBookmarks, recordEvidenceKey, recordEvidenceLabel, type ProofRecordTab, type RecordEvidence } from "../copy/proof-record";
import { type EvidenceAnchor, type SignatureView } from "../signature";
import { recordCorrectionState } from "../copy/record-context";
import { StatusBadge, statusTone } from "./StatusBadge";
import { Button } from "./Button";
import { PressableScale } from "./motion";
import { ProofEvidencePreview } from "./ProofEvidencePreview";
import { ProofRecordTimeline } from "./ProofRecordTimeline";
import { ProofTrackingPanel } from "./ProofTrackingPanel";
import { SELLER_SHIPPING_STATEMENT } from "../attestation/statement";
import { RestoringScrollView, type RestoringScrollViewHandle } from "./RestoringScrollView";

const tabs: Array<{ key: ProofRecordTab; label: string }> = [{ key: "Evidence", label: "Recording" }, { key: "Timeline", label: "Activity" }, { key: "Tracking", label: "Tracking" }];

export function ProofRecord({ statusLabel, summaryLine, action, actionInContent = false }: {
  statusLabel: string;
  summaryLine?: string;
  action: ReactNode;
  actionInContent?: boolean;
}) {
  const app = usePackProof(), { colors, reducedMotion } = useTheme();
  const proof = app.proof!, txn = app.transactionDetail ?? proof.transaction;
  const saved = useRef(app.readProofRecordView(proof.proofId));
  // Old view state may refer to the removed receipt tab; its workflow now lives in More actions.
  const [tab, setTab] = useState<ProofRecordTab>(saved.current.tab === "Receipt" ? "Evidence" : saved.current.tab), [filter, setFilter] = useState(saved.current.timelineFilter);
  const [detailsExpanded, setDetailsExpanded] = useState(saved.current.detailsExpanded ?? false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(saved.current.selectedEvidenceId ?? null);
  const [selectedEvidenceStageId, setSelectedEvidenceStageId] = useState<string | null>(saved.current.selectedEvidenceStageId ?? null);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(saved.current.selectedShipmentId ?? null);
  const [anchors, setAnchors] = useState<EvidenceAnchor[]>([]), [bookmarkError, setBookmarkError] = useState(false);
  const [bookmarksLoading, setBookmarksLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const scroll = useRef<Partial<Record<ProofRecordTab, RestoringScrollViewHandle | null>>>({});
  const tabScroll = useRef<ScrollView>(null), tabPositions = useRef<Record<string, number>>({});
  const fade = useRef(new Animated.Value(1)).current;
  const committed = committedRecordEvidence(proof);
  const selectedEvidence = committed.find(item => item.evidenceId === selectedEvidenceId && (item.stageId ?? null) === selectedEvidenceStageId) ?? committed.find(item => item.contentType?.startsWith("video/")) ?? committed[0];
  const corrections = recordCorrectionState(proof, txn, app.role, Boolean(app.localCapture && app.session?.captureProofId === proof.proofId));
  const hasVideo = committed.some(item => item.contentType?.startsWith("video/"));
  const client = app.client;
  const sellerAttestation = selectedEvidence && !selectedEvidence.stageId ? proof.attestations?.find(row =>
    row.statement === "PACKED_DESCRIBED_ITEM" && row.relatedEvidenceId === selectedEvidence.evidenceId &&
    row.authorization?.signatureVerification === "SERVER_VERIFIED" && row.authorization.method === "ANDROID_BIOMETRIC_STRONG" &&
    proof.participants.some(person => person.role === "SELLER" && person.userId === row.attestedBy)) : undefined;

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

  function saveOffset(panelTab: ProofRecordTab, offset: number) {
    // Native scroll events only update this presentation ref, avoiding render work during a fling.
    saved.current = { ...saved.current, offsets: { ...saved.current.offsets, [panelTab]: Math.max(0, offset) } };
    app.saveProofRecordView(proof.proofId, saved.current);
  }
  function selectTab(next: ProofRecordTab) {
    if (next === tab) return;
    saved.current = { ...saved.current, tab: next };
    app.saveProofRecordView(proof.proofId, saved.current);
    setTab(next);
    tabScroll.current?.scrollTo({ x: Math.max(0, (tabPositions.current[next] ?? 0) - 12), animated: !reducedMotion });
    fade.stopAnimation(); fade.setValue(reducedMotion ? 1 : 0.5);
    Animated.timing(fade, { toValue: 1, duration: reducedMotion ? 0 : motion.duration.fast, useNativeDriver: true }).start();
  }
  function selectEvidence(evidence: RecordEvidence) {
    const evidenceId = evidence.evidenceId;
    saved.current = { ...saved.current, selectedEvidenceId: evidenceId, selectedEvidenceStageId: evidence.stageId ?? null };
    app.saveProofRecordView(proof.proofId, saved.current);
    setSelectedEvidenceId(evidenceId);
    setSelectedEvidenceStageId(evidence.stageId ?? null);
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
    setFilter(next); scroll.current[tab]?.scrollTo({ y: 0, animated: !reducedMotion });
  }
  function refresh() {
    void app.run(async () => {
      await app.refreshProof(proof.proofId);
      setReload(value => value + 1);
    });
  }
  function refreshTracking() {
    void app.run(async () => {
      setTrackingError(null);
      try { await app.client.syncShipment(proof.transactionId); await app.refreshProof(proof.proofId); }
      catch (error) { setTrackingError("The latest tracking update could not be received."); throw error; }
    });
  }
  const shipping = proof.shipmentObservations?.identity ?? txn.shipping;
  const reports = proof.shipmentObservations?.events ?? [];
  const presentation = presentationForProof(proof, app.role, localProofWork(app.session?.captureProofId === proof.proofId ? app.localCapture : null,app.captureStatus,app.uploadPercent));
  const pendingUpload = presentation.displayStatus.startsWith("Uploading") || proof.evidence.some(row => row.validationStatus === "PENDING");
  function toggleDetails() {
    const next = !detailsExpanded;
    saved.current = { ...saved.current, detailsExpanded: next, offsets: next ? { ...saved.current.offsets, [tab]: 0 } : saved.current.offsets };
    app.saveProofRecordView(proof.proofId, saved.current);
    setDetailsExpanded(next);
    if (next) scroll.current[tab]?.scrollTo({ y: 0, animated: !reducedMotion });
  }

  return <View style={[styles.record,{backgroundColor:colors.surface}]}>
    <View style={[styles.tabBorder, { borderBottomColor: colors.divider }]}>
      <ScrollView ref={tabScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist" accessibilityLabel="Proof record views">
        {tabs.map(({ key, label }) => <View key={key} style={styles.tabSlot} onLayout={event => { tabPositions.current[key] = event.nativeEvent.layout.x; if (tab === key) tabScroll.current?.scrollTo({ x: Math.max(0, event.nativeEvent.layout.x - 12), animated: false }); }}><PressableScale accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: tab === key }} onPress={() => selectTab(key)} style={[styles.tab, { borderBottomColor: tab === key ? colors.accent : "transparent", backgroundColor: tab === key ? colors.accentSoft : colors.surface }]}>
          <Text style={[styles.tabLabel, { color: tab === key ? colors.accentText : colors.textSecondary }]}>{label}</Text>
        </PressableScale></View>)}
      </ScrollView>
    </View>
    <Animated.View style={[styles.panel, { opacity: fade }]}>
      {tabs.map(({ key: panelTab }) => (
      <View key={panelTab} style={[styles.panel, { display: panelTab === tab ? "flex" : "none" }]} importantForAccessibility={panelTab === tab ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={panelTab !== tab}>
      <RestoringScrollView ref={value => { scroll.current[panelTab] = value; }} contentContainerStyle={styles.body} initialOffsetY={saved.current.offsets[panelTab]} restorationReady={panelTab === tab && (panelTab !== "Evidence" || !hasVideo || !bookmarksLoading)} onScrollOffset={offset => { if (panelTab === tab) saveOffset(panelTab, offset); }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={<RefreshControl refreshing={app.busy} onRefresh={refresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}>
    <View style={[styles.top, { borderBottomColor: colors.divider }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{txn.itemTitle || "Your item"}</Text>
      <Text selectable style={[styles.note,{color:colors.textSecondary}]}>{txn.externalReference ? `Order ${txn.externalReference}` : `Proof ${proof.proofId.slice(0,8)}`}</Text>
      <Text style={[styles.note,{color:colors.textSecondary}]}>Shipment: {presentation.shipmentStatus || "No carrier update yet"}</Text>
      <View style={styles.headerMeta}>
        <StatusBadge label={statusLabel} tone={presentation.completed ? "success" : statusTone(statusLabel)} />
        <PressableScale accessibilityRole="button" accessibilityLabel="Order details" accessibilityState={{ expanded: detailsExpanded }} onPress={toggleDetails} style={styles.detailsToggle}>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Details</Text><Ionicons name={detailsExpanded ? "chevron-up" : "chevron-down"} size={15} color={colors.textSecondary} />
        </PressableScale>
      </View>
    </View>
        {detailsExpanded ? <View style={[styles.details, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Order details</Text>
          <Text style={[styles.note, { color: colors.textSecondary }]}>{corrections.sourceLabel}</Text>
          <Text selectable style={[styles.text, { color: colors.textPrimary }]}>{txn.itemTitle || "Your item"}</Text>
          {txn.externalReference ? <Text selectable style={[styles.note, { color: colors.textSecondary }]}>Order {txn.externalReference}</Text> : null}
          {summaryLine ? <Text style={[styles.note, { color: colors.textSecondary }]}>{summaryLine}</Text> : null}
          <Text style={[styles.note, { color: colors.textSecondary }]}>Created {formatDateTime(proof.createdAt)}</Text>
          <Text style={[styles.note, { color: colors.textSecondary }]}>{corrections.reason}</Text>
          {corrections.canCorrectOrder ? <Button label="Correct order details" variant="tertiary" onPress={() => app.go("editPurchase")} /> : null}
        </View> : null}
        {panelTab === "Evidence" ? <>
          {action}
          {!committed.length ? <View style={[styles.empty, { backgroundColor: colors.surfaceElevated }]}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.surfaceElevated }]}><Ionicons name="videocam-outline" size={30} color={colors.textSecondary} /></View>
            <Text style={[styles.heading, { color: colors.textPrimary }]}>{pendingUpload ? "Evidence is still uploading" : "Recording has not been added yet"}</Text>
          </View> : <>
            {committed.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectors} accessibilityLabel="Choose original evidence">{committed.map((item, index) => <PressableScale key={recordEvidenceKey(item)} onPress={() => selectEvidence(item)} accessibilityRole="button" accessibilityState={{ selected: selectedEvidence === item }} style={[styles.selector, { backgroundColor: selectedEvidence === item ? colors.accentSoft : colors.surface, borderColor: selectedEvidence === item ? colors.accentSoftBorder : colors.border }]}><Text style={[styles.subtitle, { color: colors.textPrimary }]}>{recordEvidenceLabel(item)} {index + 1}</Text></PressableScale>)}</ScrollView> : null}
            {selectedEvidence ? <ProofEvidencePreview key={recordEvidenceKey(selectedEvidence)} evidence={selectedEvidence} active={tab === "Evidence"} title={recordEvidenceLabel(selectedEvidence)} bookmarks={originalBookmarks(selectedEvidence, anchors)} initialTime={saved.current.playbackTimes?.[recordEvidenceKey(selectedEvidence)] ?? 0} onTime={seconds => savePlayback(recordEvidenceKey(selectedEvidence), seconds)} labelOffsetMs={selectedEvidence.stageId ? undefined : proof.captureShipping?.observations.find(item => item.evidenceId === selectedEvidence.evidenceId)?.detectedAtMs} /> : null}
            {sellerAttestation ? <View style={[styles.info, { borderColor: colors.border, backgroundColor: colors.successSoft }]}>
              <StatusBadge label="Attestation recorded" tone="success" />
              <Text style={[styles.text, { color: colors.textPrimary }]}>{SELLER_SHIPPING_STATEMENT}</Text>
              <Text style={[styles.note, { color: colors.textSecondary }]}>Recorded {formatDateTime(sellerAttestation.createdAt)} · Signature verified</Text>
            </View> : null}
            {bookmarkError ? <Text style={[styles.note, { color: colors.textSecondary }]}>Saved bookmarks could not be loaded. Pull down to refresh; the original recording remains available.</Text> : null}
          </>}
          <View style={[styles.details,{borderBottomColor:colors.divider}]}>
            <Text style={[styles.heading,{color:colors.textPrimary}]}>Participants</Text>
            {proof.participants.map(person => <Text key={person.participantId} style={[styles.note,{color:colors.textSecondary}]}>{person.userId === app.session?.userId ? "You · " : ""}{person.role === "SELLER" ? "Seller" : person.role === "BUYER" ? "Buyer" : person.role} · Joined {formatDateTime(person.joinedAt)}</Text>)}
          </View>
          {proof.evidence.some(item => item.validationStatus === "PENDING") ? <Text style={[styles.note, { color: colors.textSecondary }]}>A recording is still uploading.</Text> : null}
        </> : null}
        {panelTab === "Timeline" ? <ProofRecordTimeline entries={proof.chronology ?? []} auditEvents={proof.events} finalizedAt={proof.finalizedAt} filter={filter} onFilter={selectFilter} onSelect={entry => { app.setSelectedEvent(entry); app.go("event"); }} /> : null}
        {panelTab === "Tracking" ? <>
          <ProofTrackingPanel events={reports} carrier={shipping?.carrier} trackingNumber={shipping?.trackingNumber} selectedId={selectedShipmentId} onSelect={selectShipment} sync={proof.shipmentSync} registration={proof.captureShipping?.registration} refreshError={trackingError} />
          {detailsExpanded && proof.captureShipping?.observations.length ? <Text style={[styles.note, { color: colors.textSecondary }]}>A shipping code was read during recording. Its observation time and source are retained with the Proof.</Text> : null}
          {proof.shipmentSync?.available ? <Button label="Update tracking" variant="secondary" loading={app.busy} onPress={refreshTracking} /> : null}
          {corrections.canCorrectShipping ? <Button label="Correct shipping details" variant="secondary" onPress={() => app.go("editShipping")} /> : null}
        </> : null}
      </RestoringScrollView>
      </View>
      ))}
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  record: { flex: 1, minHeight: 0, padding:12, borderRadius:6 },
  top: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 8, gap: 4, borderBottomWidth: 1 }, title: { ...typography.pageTitle, fontSize: 24, lineHeight: 32 },
  subtitle: { ...typography.secondary }, tabBorder: { borderBottomWidth: 1 }, tabs: { paddingHorizontal: 12, gap: 8, flexGrow: 1 }, tabSlot: { flex: 1 },
  tab: { minWidth: 74, minHeight: 48, paddingHorizontal: 7, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 3, alignItems: "center", justifyContent: "center" }, tabLabel: { ...typography.secondary },
  panel: { flex: 1, minHeight: 0 }, body: { paddingVertical: 16, paddingBottom: 24, gap: 16 },
  text: { ...typography.body }, note: { ...typography.secondary }, heading: { ...typography.sectionTitle },
  empty: { gap: 12, paddingVertical: 12 }, emptyIcon: { width: 58, height: 58, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  selectors: { gap: 8 }, selector: { minHeight: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
  info: { padding: 16, borderWidth: 1, borderRadius: 6, gap: 10 }, eyebrow: { ...typography.caption, letterSpacing: 1.3, fontWeight: "700" },
  headerMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  detailsToggle: { minHeight: 48, flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 4 },
  details: { gap: 8, paddingBottom: 16, borderBottomWidth: 1 },
  actionFooter: { padding: 16, paddingTop: 12, borderTopWidth: 1 },
});
