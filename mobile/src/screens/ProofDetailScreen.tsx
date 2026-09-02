import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import {
  CARRIER_DISCLOSURE,
  SOURCE_DISCLOSURE,
} from "../copy/errors";
import {
  chronologyCategoryLabel,
  humanChronologyTitle,
  isShipmentAfterFinalization,
  timelineIconFor,
} from "../copy/chronology";
import {
  formatDate,
  formatDateTime,
  formatTime,
  moneyLabel,
  orderReferenceLabel,
  quantityLabel,
  shippingSummary,
  youRoleLabel,
} from "../copy/format";
import { deriveNextAction, fieldsLocked, isCompletedAction, shouldShowRequiredAction } from "../copy/next-action";
import { humanProofStatus, proofStatusLabel } from "../copy/status";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button, IconButton } from "../ui/Button";
import { BottomSheet, TechnicalDetailsSheet } from "../ui/Sheets";
import { OfflineBanner } from "../ui/EmptyState";
import { InfoCard } from "../ui/ProofCard";
import { StatusBadge, statusTone } from "../ui/StatusBadge";
import { Timeline } from "../ui/Timeline";

export function ProofDetailScreen() {
  const app = usePackProof();
  const [menuOpen, setMenuOpen] = useState(false);
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
    participationPolicy: proof.participationPolicy,
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
    hasShipping: Boolean(txn.shipping?.carrier || txn.shipping?.trackingNumber),
  });
  const seller = proof.participants.find((p) => p.role === "SELLER");
  const buyer = proof.participants.find((p) => p.role === "BUYER");
  const locked = fieldsLocked(proof.status);
  const canEdit = !locked && app.role === "SELLER";
  const events = (proof.chronology ?? []).map((entry) => ({
    id: entry.id,
    title: humanChronologyTitle(entry.eventType, entry.title),
    description: entry.description,
    timeLabel: formatTime(entry.occurredAt),
    dateLabel: formatDate(entry.occurredAt),
    category: entry.category,
    sourceLabel: chronologyCategoryLabel(entry.category, entry.source, entry.provider, entry.eventType),
    eventType: entry.eventType,
    relatedEntityId: entry.relatedEntityId,
    occurredAt: entry.occurredAt,
    afterFinalization: isShipmentAfterFinalization(entry.occurredAt, proof.finalizedAt, entry.category),
    icon: timelineIconFor(entry.eventType, entry.category),
  }));
  const summaryLine = [
    moneyLabel(txn.transactionValue, txn.currency),
    quantityLabel(txn.quantity),
    shippingSummary(txn.shipping ?? {}),
  ]
    .filter(Boolean)
    .join(" • ");

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
        app.go("invite");
        return;
      case "getting_started":
        app.go("editPurchase");
        return;
      default:
        return;
    }
  }

  const humanRows = [
    { label: "State", value: proofStatusLabel(proof.status) },
    { label: "Your role", value: youRoleLabel({ role: app.role, isCurrentUser: true }) },
    { label: "Created", value: formatDateTime(proof.createdAt) },
    { label: "Updated", value: formatDateTime(proof.updatedAt) },
    { label: "Finalized", value: formatDateTime(proof.finalizedAt) },
    { label: "Manifest SHA-256", value: proof.integrity?.manifestSha256 ?? app.manifest?.sha256 ?? "" },
  ];
  const rawRows = [
    { label: "Proof ID", value: proof.proofId },
    { label: "Transaction ID", value: proof.transactionId },
    { label: "Internal state", value: proof.status },
    { label: "Created (raw)", value: proof.createdAt },
    { label: "Updated (raw)", value: proof.updatedAt },
    { label: "Finalized (raw)", value: proof.finalizedAt ?? "" },
    { label: "Seller user ID", value: seller?.userId ?? "" },
    { label: "Buyer user ID", value: buyer?.userId ?? "" },
    { label: "Shipment supplement SHA-256", value: app.shipmentIntegrity?.shipmentSupplementSha256 ?? "" },
    { label: "Source", value: txn.provenance?.source ?? "" },
    { label: "Provider", value: txn.provenance?.provider ?? "" },
    { label: "Payload SHA-256", value: txn.provenance?.payloadSha256 ?? "" },
    ...committed.map((item, index) => ({
      label: `Evidence ${index + 1} SHA-256`,
      value: item.sha256 ?? "",
    })),
  ];

  return (
    <AppScreen extraBottom={24} onRefresh={() => void app.run(async () => app.refreshProof(proof.proofId).then(() => undefined))} refreshing={app.busy}>
      <AppHeader
        title={txn.itemTitle || "PackProof"}
        onBack={app.goBack}
        right={
          <IconButton label="Proof actions" onPress={() => setMenuOpen(true)}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.navy} />
          </IconButton>
        }
      />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <OfflineBanner visible={app.offline} message={app.offline && app.localCapture ? "Offline. Your recording is still on this device." : undefined} />

      <View style={styles.headerBlock}>
        {summaryLine ? <Text style={styles.meta}>{summaryLine}</Text> : null}
        {txn.externalReference ? <Text style={styles.meta}>{orderReferenceLabel(txn.externalReference)}</Text> : null}
        <StatusBadge label={statusLabel} tone={statusTone(statusLabel)} />
      </View>

      {shouldShowRequiredAction(action) ? (
        <InfoCard>
          <Text style={styles.kicker}>Next step</Text>
          <Text style={styles.body}>{action.hint || action.label}</Text>
          {action.enabled && action.label ? (
            <Button
              label={action.label}
              onPress={handlePrimary}
              loading={app.busy}
              icon={action.key === "start_capture" || action.key === "review_recording" ? "videocam-outline" : undefined}
            />
          ) : action.kind === "progress" ? (
            <Text style={styles.progress}>{action.label}</Text>
          ) : null}
        </InfoCard>
      ) : isCompletedAction(action) ? (
        <InfoCard>
          <View style={styles.row}>
            <Ionicons name="lock-closed" size={16} color={colors.green} />
            <Text style={styles.success}>PackProof finalized</Text>
          </View>
          <Text style={styles.meta}>Evidence record secured</Text>
        </InfoCard>
      ) : null}

      <Text style={styles.sectionTitle}>Proof record</Text>
      <Text style={styles.note}>{SOURCE_DISCLOSURE}</Text>
      <Timeline
        events={events}
        emptyLabel="This Proof record will fill in as events are recorded."
        onSelect={(event) => {
          const original = (proof.chronology ?? []).find((row) => row.id === event.id) ?? null;
          app.setSelectedEvent(original);
          app.go("event");
        }}
      />
      <Text style={styles.note}>{CARRIER_DISCLOSURE}</Text>

      <Pressable
        onPress={() => app.setTechnicalOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Technical details"
        style={styles.techRow}
      >
        <Ionicons name="information-circle-outline" size={20} color={colors.blue} />
        <Text style={styles.techLabel}>Technical details</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.navy} />
      </Pressable>

      <BottomSheet visible={menuOpen} title="Proof actions" onClose={() => setMenuOpen(false)}>
        {canEdit && !buyer ? (
          <Button
            label="Add buyer"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("invite");
            }}
          />
        ) : null}
        {canEdit ? (
          <Button
            label="Add purchase details"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("editPurchase");
            }}
          />
        ) : null}
        {canEdit ? (
          <Button
            label="Add shipping information"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("editShipping");
            }}
          />
        ) : null}
        {proof.shipmentSync?.available ? (
          <Button
            label={proof.shipmentSync.provider === "easypost" ? "Update tracking" : "Update shipment observations"}
            variant="secondary"
            loading={app.busy}
            onPress={() => {
              setMenuOpen(false);
              void app.syncShipment();
            }}
          />
        ) : null}
        <Button
          label="Technical details"
          variant="tertiary"
          onPress={() => {
            setMenuOpen(false);
            app.setTechnicalOpen(true);
          }}
        />
      </BottomSheet>

      <TechnicalDetailsSheet
        visible={app.technicalOpen}
        onClose={() => app.setTechnicalOpen(false)}
        rows={humanRows}
        rawRows={rawRows}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  headerBlock: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  kicker: { ...typography.caption, color: colors.blue },
  sectionTitle: { ...typography.sectionTitle, color: colors.navy },
  body: { ...typography.bodyStrong, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  note: { ...typography.caption, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  progress: { ...typography.bodyStrong, color: colors.blue },
  success: { ...typography.secondaryStrong, color: colors.green },
  techRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  techLabel: { ...typography.bodyStrong, color: colors.navy, flex: 1 },
});
