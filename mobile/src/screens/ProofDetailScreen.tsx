import { useState } from "react";
import { RecordedVideo } from "../ui/RecordedVideo";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { captureGradingPhoto } from "../capture";
import { ContinuityCompare } from "../ui/ContinuityCompare";
import {
  assetItemLabel,
  captureSlots,
  inviteParticipantTitle,
  isGradingWorkflow,
  nextActionNeedsCapture,
  observationProgressLabel,
  participantFacingRole,
  workflowActionFor,
} from "../copy/custody";
import { CARRIER_DISCLOSURE, SOURCE_DISCLOSURE } from "../copy/errors";
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
} from "../copy/format";
import {
  deriveNextAction,
  fieldsLocked,
  isCompletedAction,
  shouldShowRequiredAction,
} from "../copy/next-action";
import { humanProofStatus, proofStatusLabel } from "../copy/status";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button, IconButton } from "../ui/Button";
import { BottomSheet, TechnicalDetailsSheet } from "../ui/Sheets";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { InfoCard } from "../ui/ProofCard";
import { StatusBadge, statusTone } from "../ui/StatusBadge";
import { Timeline } from "../ui/Timeline";
import { ProofRecordSkeleton } from "../ui/Skeleton";

type SlotCapture = { uri: string; contentType: string };

export function ProofDetailScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [slotCaptures, setSlotCaptures] = useState<Record<string, SlotCapture>>({});
  const proof = app.proof;
  const txn = app.transactionDetail ?? proof?.transaction;
  if (!proof || !txn || !app.session) {
    return (
      <AppScreen>
        <AppHeader title="Proof" onBack={app.goBack} />
        <ProofRecordSkeleton />
      </AppScreen>
    );
  }

  const grading = isGradingWorkflow(proof.workflowType);
  const committed = (proof.evidence ?? []).filter((item) => item.validationStatus === "COMMITTED");
  const pending = (proof.evidence ?? []).filter((item) => item.validationStatus === "PENDING");
  const captureBelongs = app.session.captureProofId === proof.proofId;
  const localAction = deriveNextAction({
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
  const serverAction = proof.nextAction ?? null;
  const actionTitle = serverAction?.title || localAction.label || "";
  const actionHint = serverAction?.hint || localAction.hint || "";
  const showActionCard = grading
    ? Boolean(serverAction && serverAction.type !== "COMPLETE")
    : shouldShowRequiredAction(localAction) || Boolean(serverAction?.title || serverAction?.hint);
  const actionEnabled = grading
    ? Boolean(
        serverAction &&
          serverAction.type !== "WAIT_FOR_RECEIPT" &&
          serverAction.type !== "COMPLETE" &&
          !nextActionNeedsCapture(serverAction.type),
      )
    : Boolean(localAction.enabled && localAction.label);
  const captureRecipe = serverAction?.captureRecipe;
  const imageSlots =
    grading && nextActionNeedsCapture(serverAction?.type) ? captureSlots(captureRecipe) : [];
  const usesVideoCapture =
    grading &&
    nextActionNeedsCapture(serverAction?.type) &&
    captureRecipe === "PACKING_STANDARD_V1";
  const usesImageCapture = grading && imageSlots.length > 0 && !usesVideoCapture;
  const slotsReady = imageSlots
    .filter((slot) => slot.required)
    .every((slot) => Boolean(slotCaptures[slot.slot]));
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
  const canEdit = !locked && app.role === "SELLER" && !grading;
  const roleLabel = participantFacingRole(proof.workflowType, app.role);
  const yourRole = roleLabel ? (app.role ? `You • ${roleLabel}` : roleLabel) : "";
  const events = (proof.chronology ?? []).map((entry) => ({
    id: entry.id,
    title: humanChronologyTitle(entry.eventType, entry.title),
    description: entry.description,
    timeLabel: formatTime(entry.occurredAt),
    dateLabel: formatDate(entry.occurredAt),
    category: entry.category,
    sourceLabel: chronologyCategoryLabel(
      entry.category,
      entry.source,
      entry.provider,
      entry.eventType,
    ),
    eventType: entry.eventType,
    relatedEntityId: entry.relatedEntityId,
    occurredAt: entry.occurredAt,
    afterFinalization: isShipmentAfterFinalization(
      entry.occurredAt,
      proof.finalizedAt,
      entry.category,
    ),
    icon: timelineIconFor(entry.eventType, entry.category),
  }));
  const summaryLine = [
    moneyLabel(txn.transactionValue, txn.currency),
    quantityLabel(txn.quantity),
    shippingSummary(txn.shipping ?? {}),
  ]
    .filter(Boolean)
    .join(" • ");

  async function captureSlot(slot: string) {
    const captured = await captureGradingPhoto();
    if (!captured) {
      return;
    }
    setSlotCaptures((current) => ({ ...current, [slot]: captured }));
  }

  async function submitImageCapture() {
    const payload = imageSlots
      .map((slot) => {
        const row = slotCaptures[slot.slot];
        return row ? { slot: slot.slot, uri: row.uri, contentType: row.contentType } : null;
      })
      .filter((row): row is { slot: string; uri: string; contentType: string } => Boolean(row));
    await app.commitGradingCapture(payload);
    setSlotCaptures({});
  }

  function handlePrimary() {
    if (grading && serverAction) {
      if (serverAction.type === "FINALIZE") {
        app.go("finalize");
        return;
      }
      if (nextActionNeedsCapture(serverAction.type)) {
        if (usesVideoCapture) {
          app.go("capture");
        }
        return;
      }
      const actionName = workflowActionFor(serverAction.type);
      if (actionName) {
        void app.runWorkflowAction(actionName, {
          assetId: serverAction.assetId,
          transferId: serverAction.transferId,
          recipe: serverAction.captureRecipe,
        });
      }
      return;
    }
    switch (localAction.key) {
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

  const primaryLabel = grading ? serverAction?.title || "" : localAction.label;

  function renderPrimaryButton() {
    if (grading) {
      if (usesImageCapture) {
        return null;
      }
      if (usesVideoCapture) {
        return (
          <Button
            label={primaryLabel || "Record packing"}
            onPress={handlePrimary}
            loading={app.busy}
            icon="videocam-outline"
          />
        );
      }
      if (serverAction?.type === "WAIT_FOR_RECEIPT") {
        return null;
      }
      if (actionEnabled && primaryLabel) {
        return <Button label={primaryLabel} onPress={handlePrimary} loading={app.busy} />;
      }
      return null;
    }
    if (localAction.enabled && localAction.label) {
      return (
        <Button
          label={localAction.label}
          onPress={handlePrimary}
          loading={app.busy}
          icon={
            localAction.key === "start_capture" || localAction.key === "review_recording"
              ? "videocam-outline"
              : undefined
          }
        />
      );
    }
    if (localAction.kind === "progress") {
      return <Text style={[styles.progress, { color: colors.accent }]}>{localAction.label}</Text>;
    }
    return null;
  }
  const humanRows = [
    { label: "State", value: proofStatusLabel(proof.status) },
    { label: "Your role", value: yourRole },
    { label: "Created", value: formatDateTime(proof.createdAt) },
    { label: "Updated", value: formatDateTime(proof.updatedAt) },
    { label: "Finalized", value: formatDateTime(proof.finalizedAt) },
    {
      label: "Manifest SHA-256",
      value: proof.integrity?.manifestSha256 ?? app.manifest?.sha256 ?? "",
    },
  ];
  const rawRows = [
    { label: "Proof ID", value: proof.proofId },
    { label: "Transaction ID", value: proof.transactionId },
    { label: "Internal state", value: proof.status },
    { label: "Workflow type", value: proof.workflowType ?? "" },
    { label: "Workflow stage", value: proof.workflowStage ?? "" },
    { label: "Created (raw)", value: proof.createdAt },
    { label: "Updated (raw)", value: proof.updatedAt },
    { label: "Finalized (raw)", value: proof.finalizedAt ?? "" },
    { label: "Seller user ID", value: seller?.userId ?? "" },
    { label: "Buyer user ID", value: buyer?.userId ?? "" },
    {
      label: "Shipment supplement SHA-256",
      value: app.shipmentIntegrity?.shipmentSupplementSha256 ?? "",
    },
    { label: "Source", value: txn.provenance?.source ?? "" },
    { label: "Provider", value: txn.provenance?.provider ?? "" },
    { label: "Payload SHA-256", value: txn.provenance?.payloadSha256 ?? "" },
    ...committed.map((item, index) => ({
      label: `Evidence ${index + 1} SHA-256`,
      value: item.sha256 ?? "",
    })),
  ];

  return (
    <AppScreen
      extraBottom={24}
      onRefresh={() =>
        void app.run(async () => app.refreshProof(proof.proofId).then(() => undefined))
      }
      refreshing={app.busy}
    >
      <AppHeader
        title={txn.itemTitle || "PackProof"}
        onBack={app.goBack}
        right={
          <IconButton label="Proof actions" onPress={() => setMenuOpen(true)}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.textPrimary} />
          </IconButton>
        }
      />
      <ErrorBanner message={app.error} />
      <OfflineBanner
        visible={app.offline}
        message={
          app.offline && app.localCapture
            ? "Offline. Your recording is still on this device."
            : undefined
        }
      />

      <View style={styles.headerBlock}>
        {summaryLine ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{summaryLine}</Text>
        ) : null}
        {txn.externalReference ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {orderReferenceLabel(txn.externalReference)}
          </Text>
        ) : null}
        <StatusBadge label={statusLabel} tone={statusTone(statusLabel)} />
      </View>

      {showActionCard && (actionTitle || actionHint) ? (
        <InfoCard>
          <Text style={[styles.kicker, { color: colors.accent }]}>Next step</Text>
          <Text style={[styles.body, { color: colors.textPrimary }]}>
            {actionHint || actionTitle}
          </Text>
          {usesImageCapture ? (
            <View style={styles.slotList}>
              {imageSlots.map((slot) => (
                <View key={slot.slot} style={styles.slotRow}>
                  <Text style={[styles.meta, { color: colors.textSecondary, flex: 1 }]}>
                    {slot.prompt}
                  </Text>
                  {slotCaptures[slot.slot] ? (
                    <Text style={[styles.meta, { color: colors.success }]}>Captured</Text>
                  ) : null}
                  <Button
                    label={slotCaptures[slot.slot] ? "Retake" : "Capture"}
                    variant="secondary"
                    disabled={app.busy}
                    onPress={() => void app.run(() => captureSlot(slot.slot))}
                  />
                </View>
              ))}
              <Button
                label="Save capture"
                onPress={() => void submitImageCapture()}
                loading={app.busy}
                disabled={!slotsReady}
              />
            </View>
          ) : (
            renderPrimaryButton()
          )}
        </InfoCard>
      ) : !grading && isCompletedAction(localAction) ? (
        <InfoCard>
          <View style={styles.row}>
            <Ionicons name="lock-closed" size={16} color={colors.success} />
            <Text style={[styles.success, { color: colors.success }]}>PackProof finalized</Text>
          </View>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            Evidence record secured
          </Text>
        </InfoCard>
      ) : null}

      {proof.assets && proof.assets.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Items</Text>
          <InfoCard>
            {proof.assets.map((asset) => (
              <Text key={asset.assetId} style={[styles.body, { color: colors.textPrimary }]}>
                {assetItemLabel(asset)}
              </Text>
            ))}
          </InfoCard>
        </>
      ) : null}

      {proof.observations && proof.observations.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Progress</Text>
          <InfoCard>
            {proof.observations.map((observation) => (
              <Text
                key={observation.observationId}
                style={[styles.body, { color: colors.textPrimary }]}
              >
                {observation.label || observationProgressLabel(observation.type)}
              </Text>
            ))}
          </InfoCard>
        </>
      ) : null}

      <ContinuityCompare
        proof={proof}
        token={app.session?.token ?? null}
        contentUrl={(evidenceId) => app.client.evidenceContentUrl(proof.proofId, evidenceId)}
      />

      {committed
        .filter((e) => e.contentType?.startsWith("video/"))
        .map((e) => (
          <RecordedVideo
            key={e.evidenceId}
            uri={app.client.evidenceContentUrl(proof.proofId, e.evidenceId)}
            token={app.session!.token}
          />
        ))}
      {!grading && proof.status === "FINALIZED" ? (
        <Button
          label="Document receipt or return"
          variant="secondary"
          onPress={() => app.openReceipt(proof.proofId)}
        />
      ) : null}
      {app.localCapture && app.session.captureProofId && !captureBelongs ? (
        <Button
          label="Return to saved recording"
          variant="secondary"
          onPress={() => void app.run(() => app.openProof(app.session!.captureProofId!))}
        />
      ) : null}
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Proof record</Text>
      <Text style={[styles.note, { color: colors.textSecondary }]}>{SOURCE_DISCLOSURE}</Text>
      <Timeline
        events={events}
        emptyLabel="This Proof record will fill in as events are recorded."
        onSelect={(event) => {
          const original = (proof.chronology ?? []).find((row) => row.id === event.id) ?? null;
          app.setSelectedEvent(original);
          app.go("event");
        }}
      />
      <Text style={[styles.note, { color: colors.textSecondary }]}>{CARRIER_DISCLOSURE}</Text>

      <Pressable
        onPress={() => app.setTechnicalOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Technical details"
        style={[styles.techRow, { borderTopColor: colors.divider }]}
      >
        <Ionicons name="information-circle-outline" size={20} color={colors.accent} />
        <Text style={[styles.techLabel, { color: colors.textPrimary }]}>Technical details</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textPrimary} />
      </Pressable>

      <BottomSheet visible={menuOpen} title="Proof actions" onClose={() => setMenuOpen(false)}>
        <Button
          label="Share viewing link"
          variant="secondary"
          loading={app.busy}
          onPress={() => {
            setMenuOpen(false);
            void app.shareProofLink();
          }}
        />
        {app.role === "SELLER" && !buyer && proof.status !== "FINALIZED" ? (
          <Button
            label={inviteParticipantTitle(proof.workflowType)}
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
            label={
              proof.shipmentSync.provider === "easypost"
                ? "Update tracking"
                : "Update shipment observations"
            }
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  kicker: { ...typography.caption },
  sectionTitle: { ...typography.sectionTitle },
  body: { ...typography.bodyStrong },
  meta: { ...typography.secondary },
  note: { ...typography.caption },
  progress: { ...typography.bodyStrong },
  success: { ...typography.secondaryStrong },
  slotList: { gap: spacing.sm },
  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  techRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
  },
  techLabel: { ...typography.bodyStrong, flex: 1 },
});
