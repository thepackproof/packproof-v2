import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import {
  CARRIER_DISCLOSURE,
  MARKETPLACE_DISCLOSURE,
  SOURCE_DISCLOSURE,
} from "../copy/errors";
import { chronologyCategoryLabel, isShipmentAfterFinalization, timelineIconFor, weightFromEvent } from "../copy/chronology";
import { displayName, formatDate, formatDateTime, formatTime, moneyLabel, orderReferenceLabel, quantityLabel, shippingSummary, trackingEnding } from "../copy/format";
import { deriveNextAction, fieldsLocked } from "../copy/next-action";
import { humanProofStatus, shipmentStatusLabel, sourceLabel } from "../copy/status";
import type { ProofDetailTab } from "../app/navigation";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button, IconButton } from "../ui/Button";
import { EvidenceCard } from "../ui/EvidenceCard";
import { EmptyState, OfflineBanner } from "../ui/EmptyState";
import { InfoCard } from "../ui/ProofCard";
import { ParticipantRow } from "../ui/ParticipantRow";
import { StatusBadge, IntegrityMark, statusTone } from "../ui/StatusBadge";
import { TechnicalDetailsSheet } from "../ui/Sheets";
import { Timeline } from "../ui/Timeline";

const TABS: Array<{ id: ProofDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "shipping", label: "Shipping" },
  { id: "history", label: "History" },
];

export function ProofDetailScreen() {
  const app = usePackProof();
  const proof = app.proof;
  const txn = app.transactionDetail ?? proof?.transaction;
  if (!proof || !txn || !app.session) {
    return (
      <AppScreen>
        <AppHeader title="Proof" onBack={app.goBack} />
        <Text style={styles.meta}>Loading PackProof…</Text>
      </AppScreen>
    );
  }

  const committed = (proof.evidence ?? []).filter((item) => item.validationStatus === "COMMITTED");
  const pending = (proof.evidence ?? []).filter((item) => item.validationStatus === "PENDING");
  const captureBelongs = app.session.proofId === proof.proofId;
  const action = deriveNextAction({
    role: app.role,
    proofStatus: proof.status,
    committedEvidenceCount: committed.length,
    pendingEvidenceCount: pending.length,
    captureStatus: app.captureStatus,
    hasLocalCapture: Boolean(app.localCapture),
    captureBelongsToProof: captureBelongs,
    uploadPercent: app.uploadPercent,
    offline: app.offline,
  });
  const latestShipment = proof.shipmentObservations?.latest?.eventType ?? null;
  const statusLabel = humanProofStatus({
    proofStatus: proof.status,
    captureStatus: app.captureStatus,
    hasLocalCapture: Boolean(app.localCapture),
    captureBelongsToProof: captureBelongs,
    latestShipmentEventType: latestShipment,
  });
  const seller = proof.participants.find((p) => p.role === "SELLER");
  const buyer = proof.participants.find((p) => p.role === "BUYER");
  const locked = fieldsLocked(proof.status);
  const events = (proof.chronology ?? []).map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    timeLabel: formatTime(entry.occurredAt),
    dateLabel: formatDate(entry.occurredAt),
    category: entry.category,
    sourceLabel: chronologyCategoryLabel(entry.category, entry.source, entry.provider),
    eventType: entry.eventType,
    relatedEntityId: entry.relatedEntityId,
    occurredAt: entry.occurredAt,
    afterFinalization: isShipmentAfterFinalization(entry.occurredAt, proof.finalizedAt, entry.category),
    icon: timelineIconFor(entry.eventType, entry.category),
  }));
  const shipmentEvents = proof.shipmentObservations?.events ?? [];

  function handlePrimary() {
    switch (action.key) {
      case "start_capture":
      case "review_recording":
      case "retry_upload":
        app.go("capture");
        return;
      case "finalize":
        app.go("finalize");
        return;
      case "add_participant":
      case "getting_started":
        app.go("invite");
        return;
      default:
        return;
    }
  }

  const technicalRows = [
    { label: "Proof ID", value: proof.proofId },
    { label: "Transaction ID", value: proof.transactionId },
    { label: "Status", value: proof.status },
    { label: "Role", value: app.role ?? "" },
    { label: "Created", value: proof.createdAt },
    { label: "Updated", value: proof.updatedAt },
    { label: "Finalized", value: proof.finalizedAt ?? "" },
    { label: "Manifest SHA-256", value: proof.integrity?.manifestSha256 ?? app.manifest?.sha256 ?? "" },
    { label: "Seller user ID", value: seller?.userId ?? "" },
    { label: "Buyer user ID", value: buyer?.userId ?? "" },
    { label: "Shipment supplement SHA-256", value: app.shipmentIntegrity?.shipmentSupplementSha256 ?? "" },
    { label: "Source", value: txn.provenance?.source ?? "" },
    { label: "Provider", value: txn.provenance?.provider ?? "" },
    { label: "Payload SHA-256", value: txn.provenance?.payloadSha256 ?? "" },
  ];

  return (
    <AppScreen extraBottom={24} onRefresh={() => void app.run(async () => app.refreshProof(proof.proofId).then(() => undefined))} refreshing={app.busy}>
      <AppHeader
        title={txn.itemTitle || "PackProof"}
        onBack={app.goBack}
        right={
          <IconButton label="Technical details" onPress={() => app.setTechnicalOpen(true)}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.navy} />
          </IconButton>
        }
      />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <OfflineBanner visible={app.offline} message={app.offline && app.localCapture ? "Offline. Your recording is still on this device." : undefined} />
      <View style={styles.headingRow}>
        <View style={styles.flex}>
          {txn.externalReference ? <Text style={styles.meta}>{orderReferenceLabel(txn.externalReference)}</Text> : null}
          <View style={styles.row}>
            <StatusBadge label={statusLabel} tone={statusTone(statusLabel)} />
            <IntegrityMark state={proof.status === "FINALIZED" ? "finalized" : committed.length > 0 ? "secured" : "none"} />
          </View>
        </View>
      </View>

      <View style={styles.summary}>
        <Text style={styles.meta}>Seller · {seller?.userId === app.session.userId ? "You" : "Seller"}</Text>
        <Text style={styles.meta}>Buyer · {buyer ? (buyer.userId === app.session.userId ? "You" : "Buyer") : "Not added"}</Text>
        <Text style={styles.meta}>
          {[shippingSummary(txn.shipping ?? {}), trackingEnding(txn.shipping?.trackingNumber)].filter(Boolean).join(" · ") || "No shipping details"}
        </Text>
      </View>

      {action.hint || action.label ? (
        <InfoCard>
          <Text style={styles.kicker}>Next step</Text>
          <Text style={styles.body}>{action.hint || action.label}</Text>
          {action.enabled && action.label ? (
            <Button label={action.label} onPress={handlePrimary} loading={app.busy} variant={action.kind === "success" ? "success" : "primary"} />
          ) : action.kind === "progress" ? (
            <Text style={styles.progress}>{action.label}</Text>
          ) : action.kind === "success" ? (
            <View style={styles.row}>
              <Ionicons name="lock-closed" size={16} color={colors.green} />
              <Text style={styles.success}>{action.label}</Text>
            </View>
          ) : null}
        </InfoCard>
      ) : null}

      <View style={styles.tabs}>
        {TABS.map((tab) => {
          const selected = app.proofDetailTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => app.setProofDetailTab(tab.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              style={[styles.tab, selected ? styles.tabActive : null]}
            >
              <Text style={[styles.tabLabel, selected ? styles.tabLabelActive : null]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {app.proofDetailTab === "overview" ? (
        <View style={styles.stack}>
          <InfoCard>
            <Text style={styles.cardTitle}>{txn.itemTitle || "Untitled item"}</Text>
            {txn.itemDescription ? <Text style={styles.body}>{txn.itemDescription}</Text> : null}
            <Text style={styles.meta}>
              {[quantityLabel(txn.quantity), moneyLabel(txn.transactionValue, txn.currency)].filter(Boolean).join(" • ")}
            </Text>
            {txn.transactionDate ? <Text style={styles.meta}>{formatDate(txn.transactionDate)}</Text> : null}
            {txn.provenance ? (
              <>
                <Text style={styles.meta}>{sourceLabel(txn.provenance.source, txn.provenance.provider)}</Text>
                <Text style={styles.note}>{MARKETPLACE_DISCLOSURE}</Text>
              </>
            ) : null}
          </InfoCard>
          <SectionHeader
            title="Purchase details"
            actionLabel={locked ? undefined : "Edit"}
            onAction={locked ? undefined : () => app.go("editPurchase")}
          />
          {locked ? (
            <View style={styles.lockNote}>
              <Ionicons name="lock-closed" size={16} color={colors.green} />
              <Text style={styles.success}>Included in finalized PackProof</Text>
            </View>
          ) : null}
          <SectionHeader
            title="People"
            actionLabel={locked || app.role !== "SELLER" ? undefined : "Add"}
            onAction={locked || app.role !== "SELLER" ? undefined : () => app.go("invite")}
          />
          {seller ? (
            <ParticipantRow
              name={seller.userId === app.session.userId ? displayName({ displayName: app.session.displayName, username: app.session.username, fallback: "You" }) : "Seller"}
              role="Seller"
              you={seller.userId === app.session.userId}
            />
          ) : null}
          {buyer ? (
            <ParticipantRow
              name={buyer.userId === app.session.userId ? displayName({ displayName: app.session.displayName, username: app.session.username, fallback: "You" }) : "Buyer"}
              role="Buyer"
              you={buyer.userId === app.session.userId}
            />
          ) : app.role === "SELLER" && !locked ? (
            <Button label="Add participant" onPress={() => app.go("invite")} variant="secondary" />
          ) : (
            <Text style={styles.meta}>No buyer has joined this PackProof.</Text>
          )}
        </View>
      ) : null}

      {app.proofDetailTab === "evidence" ? (
        <View style={styles.stack}>
          {committed.length === 0 && pending.length === 0 && !app.localCapture ? (
            <EmptyState
              title="No evidence yet"
              body={app.role === "SELLER" ? "Record the item being packed and sealed." : "Seller evidence will appear here once it is secured."}
              actionLabel={action.key === "start_capture" ? "Start evidence capture" : undefined}
              onAction={action.key === "start_capture" ? () => app.go("capture") : undefined}
              icon="videocam-outline"
            />
          ) : null}
          {committed.map((item) => (
            <EvidenceCard
              key={item.evidenceId}
              title="Seller packing evidence"
              stateLabel="Evidence secured"
              byteSize={item.byteSize}
              hash={item.sha256}
              committed
            />
          ))}
          {pending.length > 0 && committed.length === 0 ? (
            <EvidenceCard title="Seller packing evidence" stateLabel="Upload started but not secured" />
          ) : null}
          {captureBelongs && app.localCapture ? (
            <EvidenceCard
              title="Recording on this device"
              stateLabel={app.offline ? "Saved locally · waiting to upload" : "Recording ready"}
              durationMs={app.localCapture.durationMs}
              byteSize={app.localCapture.byteSize}
            />
          ) : null}
          {(proof.attestations ?? []).map((row) => (
            <InfoCard key={row.attestationId}>
              <Text style={styles.cardTitle}>Attestation</Text>
              <Text style={styles.body}>
                {row.statement === "PACKED_DESCRIBED_ITEM"
                  ? "The seller attested that the packed item is the item associated with this transaction."
                  : row.statement}
              </Text>
              <Text style={styles.meta}>{formatDateTime(row.createdAt)}</Text>
            </InfoCard>
          ))}
        </View>
      ) : null}

      {app.proofDetailTab === "shipping" ? (
        <View style={styles.stack}>
          <SectionHeader
            title="Shipping"
            actionLabel={locked ? undefined : "Edit"}
            onAction={locked ? undefined : () => app.go("editShipping")}
          />
          {locked ? (
            <View style={styles.lockNote}>
              <Ionicons name="lock-closed" size={16} color={colors.green} />
              <Text style={styles.success}>Core shipping details are included in the finalized PackProof</Text>
            </View>
          ) : null}
          <InfoCard>
            <Text style={styles.cardTitle}>{shippingSummary(txn.shipping ?? {}) || "No shipping details"}</Text>
            {txn.shipping?.trackingNumber ? <Text style={styles.body}>{txn.shipping.trackingNumber}</Text> : null}
            {latestShipment ? <StatusBadge label={shipmentStatusLabel(latestShipment)} tone="info" /> : null}
          </InfoCard>
          {shipmentEvents.length === 0 ? (
            <Text style={styles.meta}>No carrier observations have been recorded yet.</Text>
          ) : (
            shipmentEvents.map((event) => (
              <View key={event.id} style={styles.shipEvent}>
                <Text style={styles.cardTitle}>{shipmentStatusLabel(event.eventType)}</Text>
                {event.location ? <Text style={styles.body}>{event.location}</Text> : null}
                <Text style={styles.meta}>{formatDateTime(event.occurredAt)}</Text>
                {weightFromEvent(event) ? <Text style={styles.meta}>Weight reported by carrier · {weightFromEvent(event)}</Text> : null}
                {proof.finalizedAt && new Date(event.occurredAt).getTime() > new Date(proof.finalizedAt).getTime() ? (
                  <Text style={styles.note}>Appended after finalization. Did not change the sealed record.</Text>
                ) : null}
              </View>
            ))
          )}
          <Text style={styles.note}>{CARRIER_DISCLOSURE}</Text>
          {proof.shipmentSync?.available ? (
            <Button
              label={proof.shipmentSync.provider === "easypost" ? "Update tracking" : "Update shipment observations"}
              onPress={() => void app.syncShipment()}
              variant="secondary"
              loading={app.busy}
            />
          ) : null}
        </View>
      ) : null}

      {app.proofDetailTab === "history" ? (
        <View style={styles.stack}>
          <SectionHeader title="Proof history" />
          <Text style={styles.note}>{SOURCE_DISCLOSURE}</Text>
          <Timeline
            events={events}
            onSelect={(event) => {
              const original = (proof.chronology ?? []).find((row) => row.id === event.id) ?? null;
              app.setSelectedEvent(original);
              app.go("event");
            }}
          />
        </View>
      ) : null}

      <TechnicalDetailsSheet visible={app.technicalOpen} onClose={() => app.setTechnicalOpen(false)} rows={technicalRows} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  headingRow: { flexDirection: "row", alignItems: "flex-start" },
  flex: { flex: 1, gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  summary: { gap: 4 },
  kicker: { ...typography.caption, color: colors.blue },
  cardTitle: { ...typography.cardTitle, color: colors.navy },
  body: { ...typography.body, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  note: { ...typography.caption, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  progress: { ...typography.bodyStrong, color: colors.blue },
  success: { ...typography.secondaryStrong, color: colors.green },
  lockNote: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  tabs: { flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    minHeight: 40,
    justifyContent: "center",
  },
  tabActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  tabLabel: { ...typography.secondaryStrong, color: colors.navy },
  tabLabelActive: { color: colors.white },
  stack: { gap: spacing.md },
  shipEvent: { gap: 4, paddingLeft: spacing.md, borderLeftWidth: 3, borderLeftColor: colors.blue },
});
