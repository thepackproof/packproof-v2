import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { FINALIZE_DISCLOSURE } from "../copy/errors";
import { displayName, orderReferenceLabel, shippingSummary } from "../copy/format";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ConfirmationSheet } from "../ui/Sheets";
import { InfoCard } from "../ui/ProofCard";
import { ErrorBanner } from "../ui/EmptyState";

export function FinalizeScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proof = app.proof;
  const txn = app.transactionDetail ?? proof?.transaction;
  const buyer = proof?.participants.find((p) => p.role === "BUYER");
  if (!proof || !txn) {
    return null;
  }
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Finalize PackProof" onBack={app.goBack} />
      <ErrorBanner message={app.error} />
      <InfoCard>
        <Row label="Order" value={orderReferenceLabel(txn.externalReference) || "No order reference"} />
        <Row label="Item" value={txn.itemTitle || "Untitled item"} />
        <Row
          label="Buyer"
          value={buyer ? displayName({ fallback: "Buyer joined" }) : "No buyer on this record yet"}
        />
        <Row label="Shipping" value={shippingSummary(txn.shipping ?? {}) || "No shipping details"} />
        <Row
          label="Evidence"
          value={(proof.evidence ?? []).some((item) => item.validationStatus === "COMMITTED") ? "Evidence secured" : "Not secured"}
        />
      </InfoCard>
      <Text style={[styles.note, { color: colors.textSecondary }]}>{FINALIZE_DISCLOSURE}</Text>
      <Button label="Finalize PackProof" onPress={() => app.setConfirmFinalize(true)} disabled={app.busy} haptic="medium" />
      <ConfirmationSheet
        visible={app.confirmFinalize}
        title="Finalize PackProof"
        message={FINALIZE_DISCLOSURE}
        confirmLabel="Finalize PackProof"
        busy={app.busy}
        onConfirm={() => void app.finalizeProof()}
        onClose={() => app.setConfirmFinalize(false)}
      />
    </AppScreen>
  );
}

function Row(props: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{props.label}</Text>
      <Text style={[styles.value, { color: colors.textPrimary }]}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...typography.caption },
  value: { ...typography.bodyStrong },
  note: { ...typography.secondary },
});
