import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { MARKETPLACE_DISCLOSURE } from "../copy/errors";
import { displayName, formatDate, moneyLabel, quantityLabel } from "../copy/format";
import { providerDisplay } from "../copy/status";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";
import { SourceBadge } from "../ui/SourceBadge";

export function PurchaseReviewScreen() {
  const app = usePackProof();
  const imported = app.importReview;
  if (!imported) {
    return (
      <AppScreen>
        <AppHeader title="Review purchase" onBack={app.goBack} />
        <Text style={styles.body}>No imported purchase to review.</Text>
      </AppScreen>
    );
  }
  const txn = imported.transaction;
  const buyer = txn.provenance?.buyer;
  const existing = Boolean(imported.proof || txn.proofId);
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Review purchase" onBack={app.goBack} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <InfoCard>
        <Text style={styles.title}>{txn.itemTitle || "Imported purchase"}</Text>
        {txn.itemDescription ? <Text style={styles.body}>{txn.itemDescription}</Text> : null}
        <Text style={styles.meta}>
          {[quantityLabel(txn.quantity), moneyLabel(txn.transactionValue, txn.currency)].filter(Boolean).join(" • ")}
        </Text>
        {txn.transactionDate ? <Text style={styles.meta}>Purchased {formatDate(txn.transactionDate)}</Text> : null}
      </InfoCard>
      <InfoCard>
        <Text style={styles.label}>Buyer</Text>
        <Text style={styles.body}>{displayName({ displayName: buyer?.displayName, email: buyer?.email, fallback: "Not provided" })}</Text>
      </InfoCard>
      <InfoCard>
        <Text style={styles.label}>Shipping</Text>
        <Text style={styles.body}>{[txn.shipping?.carrier, txn.shipping?.service].filter(Boolean).join(" ") || "Not provided"}</Text>
        {txn.shipping?.trackingNumber ? <Text style={styles.meta}>{txn.shipping.trackingNumber}</Text> : null}
      </InfoCard>
      <SourceBadge category="COMMERCE" label={`Imported from ${providerDisplay(txn.provenance?.provider ?? imported.identity.adapterKey)}`} />
      <Text style={styles.disclosure}>{MARKETPLACE_DISCLOSURE}</Text>
      {existing ? (
        <Text style={styles.meta}>A PackProof already exists for this order.</Text>
      ) : null}
      <Button
        label={existing ? "Open existing Proof" : "Create PackProof"}
        onPress={() => void app.confirmImportedPurchase()}
        loading={app.busy}
      />
      <Button
        label="Edit details"
        onPress={() => {
          app.setCreateForm({
            externalReference: txn.externalReference ?? "",
            transactionDate: txn.transactionDate ?? "",
            itemTitle: txn.itemTitle ?? "",
            itemDescription: txn.itemDescription ?? "",
            quantity: txn.quantity == null ? "" : String(txn.quantity),
            transactionValue: txn.transactionValue == null ? "" : String(txn.transactionValue),
            currency: txn.currency ?? "",
            carrier: txn.shipping?.carrier ?? "",
            service: txn.shipping?.service ?? "",
            trackingNumber: txn.shipping?.trackingNumber ?? "",
            shipmentDate: txn.shipping?.shipmentDate ?? "",
          });
          app.go("manual");
        }}
        variant="secondary"
        disabled={app.busy}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.cardTitle, color: colors.navy },
  label: { ...typography.caption, color: colors.slate },
  body: { ...typography.body, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  disclosure: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
});
