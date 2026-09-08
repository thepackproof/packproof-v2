import { useState, type ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
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
import {
  formatDateTime,
  moneyLabel,
  quantityLabel,
  shippingSummary,
} from "../copy/format";
import {
  deriveNextAction,
  isCompletedAction,
  shouldShowRequiredAction,
} from "../copy/next-action";
import { recordCorrectionState } from "../copy/record-context";
import { PressableScale } from "../ui/motion";
import { proofStatusLabel } from "../copy/status";
import { recordNextStepCopy, recordProofStatus } from "../copy/proof-record";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button, IconButton } from "../ui/Button";
import { BottomSheet, TechnicalDetailsSheet } from "../ui/Sheets";
import { ErrorBanner, OfflineBanner } from "../ui/EmptyState";
import { InfoCard } from "../ui/ProofCard";
import { ProofRecord } from "../ui/ProofRecord";
import { ProofRecordSkeleton } from "../ui/Skeleton";

type SlotCapture = { uri: string; contentType: string };

export function ProofDetailScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [workflowDetailsOpen, setWorkflowDetailsOpen] = useState(false);
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
    hasLocalCapture: Boolean(app.localCapture) && !(app.captureStatus === "committed" && committed.length > 0),
    captureBelongsToProof: captureBelongs,
    uploadPercent: app.uploadPercent,
    offline: app.offline,
  });
  const serverAction = proof.nextAction ?? null;
  const { title: actionTitle, hint: actionHint } = recordNextStepCopy(localAction, serverAction, grading);
  const showActionCard = grading
    ? Boolean(serverAction && serverAction.type !== "COMPLETE")
    : shouldShowRequiredAction(localAction);
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
  const statusLabel = recordProofStatus(proof.status);
  const seller = proof.participants.find((p) => p.role === "SELLER");
  const buyer = proof.participants.find((p) => p.role === "BUYER");
  const corrections = recordCorrectionState(proof, txn, app.role, Boolean(app.localCapture && captureBelongs));
  const roleLabel = participantFacingRole(proof.workflowType, app.role);
  const yourRole = roleLabel ? (app.role ? `You • ${roleLabel}` : roleLabel) : "";
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
        void app.finalizeProof();
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
    <AppScreen scroll={false} extraBottom={0}>
      <AppHeader
        title="Proof"
        onBack={app.goBack}
        right={
          <IconButton label="More actions" onPress={() => setMenuOpen(true)}>
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

      <ProofRecord
        key={proof.proofId}
        statusLabel={statusLabel}
        summaryLine={summaryLine}
        actionInContent={usesImageCapture}
        action={showActionCard || (!grading && isCompletedAction(localAction) && (app.role === "SELLER" || app.role === "BUYER")) || (app.localCapture && app.session.captureProofId && !captureBelongs) ? <>
{showActionCard && (actionTitle || actionHint) ? (
        <View style={styles.action}>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
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
        </View>
      ) : !grading && isCompletedAction(localAction) && app.role === "SELLER" ? (
        <Button label="Share Proof" icon="share-outline" onPress={() => void app.shareProofLink()} />
      ) : !grading && isCompletedAction(localAction) && app.role === "BUYER" ? (
        <Button label="Document receipt or return" onPress={() => app.openReceipt(proof.proofId)} />
      ) : null}
{app.localCapture && app.session.captureProofId && !captureBelongs ? (
        <Button
          label="Return to saved recording"
          variant="secondary"
          onPress={() => void app.run(() => app.openProof(app.session!.captureProofId!))}
        />
      ) : null}
        </> : null}
      />

      <BottomSheet visible={menuOpen} title="More actions" onClose={() => setMenuOpen(false)}>
        <MoreAction label="Evidence and claim tools" variant="secondary" onPress={() => { setMenuOpen(false); app.go("signature"); }} />
        {!grading && proof.status === "FINALIZED" ? <MoreAction label="Receipt and returns" variant="secondary" onPress={() => { setMenuOpen(false); app.openReceipt(proof.proofId); }} /> : null}
        {app.role === "SELLER" ? <MoreAction
          label="Share Proof"
          variant="secondary"
          loading={app.busy}
          onPress={() => {
            setMenuOpen(false);
            void app.shareProofLink();
          }}
        /> : null}
        {app.role === "SELLER" && !buyer && proof.status !== "FINALIZED" ? (
          <MoreAction
            label={inviteParticipantTitle(proof.workflowType)}
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("invite");
            }}
          />
        ) : null}
        {!grading && corrections.canCorrectOrder ? (
          <MoreAction
            label="Correct order details"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("editPurchase");
            }}
          />
        ) : null}
        {!grading && corrections.canCorrectShipping ? (
          <MoreAction
            label="Correct shipping details"
            variant="secondary"
            onPress={() => {
              setMenuOpen(false);
              app.go("editShipping");
            }}
          />
        ) : null}
        {proof.shipmentSync?.available ? (
          <MoreAction
            label={
              ["easypost", "shippo"].includes(proof.shipmentSync.provider ?? "")
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
        {grading || Boolean(proof.assets?.length || proof.observations?.length || proof.continuityObservations?.length) ? <MoreAction label="Items and custody details" variant="secondary" onPress={() => { setMenuOpen(false); setWorkflowDetailsOpen(true); }} /> : null}
        <MoreAction
          label="Technical details"
          variant="tertiary"
          onPress={() => {
            setMenuOpen(false);
            app.setTechnicalOpen(true);
          }}
        />
      </BottomSheet>

      <BottomSheet visible={workflowDetailsOpen} title="Items and custody details" onClose={() => setWorkflowDetailsOpen(false)}>
        <View style={styles.workflowDetails}>

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

        </View>
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

function MoreAction({ label, onPress, loading }: Pick<ComponentProps<typeof Button>, "label" | "onPress" | "loading" | "variant">) {
  const { colors } = useTheme();
  const icon: ComponentProps<typeof Ionicons>["name"] = label.includes("Share") ? "share-outline"
    : label.includes("tracking") || label.includes("shipment") ? "location-outline"
    : label.includes("Correct") ? "create-outline"
    : label.includes("Technical") ? "document-text-outline"
    : label.includes("Receipt") ? "return-down-back-outline"
    : label.includes("buyer") ? "person-add-outline" : "folder-open-outline";
  return <PressableScale accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(loading), busy: Boolean(loading) }} disabled={loading} onPress={onPress} style={[styles.moreRow, { borderBottomColor: colors.divider }]}>
    <Ionicons name={icon} size={22} color={colors.textSecondary} />
    <Text style={[styles.body, { color: colors.textPrimary, flex: 1 }]}>{label}</Text>
    <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
  </PressableScale>;
}

const styles = StyleSheet.create({
  moreRow: { minHeight: 52, paddingVertical: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.md, borderBottomWidth: 1 },
  action: { gap: spacing.sm },
  workflowDetails: { gap: spacing.md, paddingBottom: spacing.lg },
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
