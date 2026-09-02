import { StyleSheet, Text } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { MARKETPLACE_DISCLOSURE } from "../copy/errors";
import { displayName, formatDate, moneyLabel, quantityLabel } from "../copy/format";
import { providerDisplay } from "../copy/status";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";
import { SourceBadge } from "../ui/SourceBadge";
import { ErrorBanner } from "../ui/EmptyState";

export function PurchaseReviewScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const imported = app.importReview;
  if (!imported) {
    return (
      <AppScreen>
        <AppHeader title="Review purchase" onBack={app.goBack} />
        <Text style={[styles.body, { color: colors.textPrimary }]}>No imported purchase to review.</Text>
      </AppScreen>
    );
  }
  const txn = imported.transaction;
  const buyer = txn.provenance?.buyer;
  const existing = Boolean(imported.proof || txn.proofId);
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Review purchase" onBack={app.goBack} />
      <ErrorBanner message={app.error} />
      <InfoCard>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{txn.itemTitle || "Imported purchase"}</Text>
        {txn.itemDescription ? <Text style={[styles.body, { color: colors.textPrimary }]}>{txn.itemDescription}</Text> : null}
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          {[quantityLabel(txn.quantity), moneyLabel(txn.transactionValue, txn.currency)].filter(Boolean).join(" • ")}
        </Text>
        {txn.transactionDate ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>Purchased {formatDate(txn.transactionDate)}</Text>
        ) : null}
      </InfoCard>
      <InfoCard>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Buyer</Text>
        <Text style={[styles.body, { color: colors.textPrimary }]}>
          {displayName({ displayName: buyer?.displayName, email: buyer?.email, fallback: "Not provided" })}
        </Text>
      </InfoCard>
      <InfoCard>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Shipping</Text>
        <Text style={[styles.body, { color: colors.textPrimary }]}>
          {[txn.shipping?.carrier, txn.shipping?.service].filter(Boolean).join(" ") || "Not provided"}
        </Text>
        {txn.shipping?.trackingNumber ? (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{txn.shipping.trackingNumber}</Text>
        ) : null}
      </InfoCard>
      <SourceBadge category="COMMERCE" label={`Imported from ${providerDisplay(txn.provenance?.provider ?? imported.identity.adapterKey)}`} />
      <Text style={[styles.disclosure, { color: colors.textSecondary }]}>{MARKETPLACE_DISCLOSURE}</Text>
      {existing ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>A PackProof already exists for this order.</Text>
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
  title: { ...typography.cardTitle },
  label: { ...typography.caption },
  body: { ...typography.body },
  meta: { ...typography.secondary },
  disclosure: { ...typography.secondary },
});
