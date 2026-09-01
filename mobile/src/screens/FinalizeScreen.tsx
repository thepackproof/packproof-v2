import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { FINALIZE_DISCLOSURE } from "../copy/errors";
import { displayName, orderReferenceLabel, shippingSummary } from "../copy/format";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { ConfirmationSheet } from "../ui/Sheets";
import { InfoCard } from "../ui/ProofCard";

export function FinalizeScreen() {
  const app = usePackProof();
  const proof = app.proof;
  const txn = app.transactionDetail ?? proof?.transaction;
  const buyer = proof?.participants.find((p) => p.role === "BUYER");
  if (!proof || !txn) {
    return null;
  }
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Finalize PackProof" onBack={app.goBack} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <InfoCard>
        <Row label="Order" value={orderReferenceLabel(txn.externalReference) || "No order reference"} />
        <Row label="Item" value={txn.itemTitle || "Untitled item"} />
        <Row
          label="Buyer"
          value={buyer ? displayName({ fallback: "Buyer joined" }) : "No buyer on this record yet"}
        />
        <Row label="Shipping" value={shippingSummary(txn.shipping ?? {}) || "No shipping details"} />
        <Row label="Evidence" value={(proof.evidence ?? []).some((item) => item.validationStatus === "COMMITTED") ? "Evidence secured" : "Not secured"} />
      </InfoCard>
      <Text style={styles.note}>{FINALIZE_DISCLOSURE}</Text>
      <Button label="Finalize PackProof" onPress={() => app.setConfirmFinalize(true)} disabled={app.busy} />
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
  return (
    <View style={{ gap: 2 }}>
      <Text style={styles.label}>{props.label}</Text>
      <Text style={styles.value}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...typography.caption, color: colors.slate },
  value: { ...typography.bodyStrong, color: colors.navy },
  note: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
});
