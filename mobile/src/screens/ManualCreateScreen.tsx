import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { usePackProof } from "../app/PackProofProvider";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Ionicons } from "@expo/vector-icons";
import { Button, IconButton } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { DateField } from "../ui/DateField";
import { ErrorBanner } from "../ui/EmptyState";
import { spacing, typography } from "../theme/tokens";

const COMMON_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD"] as const;

export function ManualCreateScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const form = app.createForm;
  const setForm = app.setCreateForm;
  const [showDetails, setShowDetails] = useState(Boolean(app.intakeReview));

  useEffect(() => {
    setForm((current) => {
      if (current.quantity || current.currency) return current;
      return { ...current, quantity: "1", currency: "USD" };
    });
  }, [setForm]);

  const parsedQuantity = Number.parseInt(form.quantity, 10);
  const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
  const commonCurrency = COMMON_CURRENCIES.includes(form.currency.toUpperCase() as (typeof COMMON_CURRENCIES)[number]);

  function changeQuantity(delta: number) {
    setForm({ ...form, quantity: String(Math.max(1, quantity + delta)) });
  }

  function chooseCurrency(currency: string) {
    setForm({ ...form, currency });
  }

  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="New Proof" onBack={app.goBack} right={<IconButton label="Share Proof" onPress={() => Alert.alert("Share Proof", app.offline ? "Connect to create a share link. Your draft is kept." : "Create this Proof to get a share link. Your draft is kept.")}><Ionicons name="share-outline" size={22} color={colors.textPrimary} /></IconButton>} />
      <ErrorBanner message={app.error} />
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>Connected-store orders appear automatically in Proofs. Add another shipment here.</Text>
      {app.intakeReview ? (
        <>
          <SectionHeader title="Review your order" />
          {app.intakeReview.warnings.map((warning, i) => (
            <Text key={i} style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{warning}</Text>
          ))}
        </>
      ) : null}
      <FormField
        label="What are you shipping?"
        value={form.itemTitle}
        onChangeText={(value) => setForm({ ...form, itemTitle: value })}
        autoCapitalize="sentences"
      />
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>Show the shipping label during your packing video. PackProof will try to read it for you.</Text>
      <Button label="Paste order or receipt" variant="tertiary" onPress={() => app.go("intake")} />
      <Button
        label={showDetails ? "Hide optional details" : "Add optional details"}
        variant="tertiary"
        onPress={() => setShowDetails(!showDetails)}
      />
      {showDetails ? (
        <>
          <FormField
            label="Description"
            value={form.itemDescription}
            onChangeText={(value) => setForm({ ...form, itemDescription: value })}
            multiline
            autoCapitalize="sentences"
          />
          <FormField
            label="Order number (optional)"
            placeholder="Store or marketplace order #"
            value={form.externalReference}
            onChangeText={(value) => setForm({ ...form, externalReference: value })}
          />
          <DateField
            label="Purchase date (optional)"
            value={form.transactionDate}
            onChange={(value) => setForm({ ...form, transactionDate: value })}
            optional
          />

          <SectionHeader title="Item value" />
          <View style={styles.quantityRow}>
            <Button label="−" variant="tertiary" disabled={quantity <= 1} onPress={() => changeQuantity(-1)} />
            <View style={styles.quantityField}>
              <FormField
                label="Quantity"
                value={form.quantity}
                onChangeText={(value) => setForm({ ...form, quantity: value.replace(/[^0-9]/g, "") })}
                keyboardType="number-pad"
              />
            </View>
            <Button label="+" variant="tertiary" onPress={() => changeQuantity(1)} />
          </View>
          <FormField
            label={`Value (${form.currency || "USD"})`}
            placeholder="0.00"
            value={form.transactionValue}
            onChangeText={(value) => setForm({ ...form, transactionValue: value })}
            keyboardType="decimal-pad"
          />
          <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>Currency</Text>
          <View style={styles.currencyRow}>
            {COMMON_CURRENCIES.map((currency) => (
              <Button
                key={currency}
                label={`${form.currency.toUpperCase() === currency ? "✓ " : ""}${currency}`}
                variant="tertiary"
                onPress={() => chooseCurrency(currency)}
              />
            ))}
            <Button label={!commonCurrency ? "✓ Other" : "Other"} variant="tertiary" onPress={() => commonCurrency && chooseCurrency("")} />
          </View>
          {!commonCurrency ? (
            <FormField
              label="Currency code"
              placeholder="USD"
              value={form.currency}
              onChangeText={(value) => setForm({ ...form, currency: value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) })}
              autoCapitalize="characters"
            />
          ) : null}

          <SectionHeader title="Shipping details" />
          <FormField
            label="Carrier"
            placeholder="USPS, UPS, FedEx…"
            value={form.carrier}
            onChangeText={(value) => setForm({ ...form, carrier: value })}
            autoCapitalize="words"
          />
          <FormField
            label="Tracking number"
            value={form.trackingNumber}
            onChangeText={(value) => setForm({ ...form, trackingNumber: value })}
          />
          <FormField
            label="Shipping service (optional)"
            placeholder="USPS Ground Advantage"
            value={form.service}
            onChangeText={(value) => setForm({ ...form, service: value })}
            autoCapitalize="words"
          />
          <DateField
            label="Label ship date (optional)"
            value={form.shipmentDate}
            onChange={(value) => setForm({ ...form, shipmentDate: value })}
            optional
          />
          <Text style={[styles.help, { color: colors.textSecondary }]}>The label’s ship date is not proof of carrier acceptance. PackProof records the carrier’s first acceptance scan separately when tracking is available.</Text>
        </>
      ) : null}
      <Button
        disabled={!form.itemTitle.trim()}
        label="Open camera"
        onPress={() => void app.createManualProof()}
        loading={app.busy}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  quantityRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  quantityField: { flex: 1 },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  fieldLabel: { ...typography.secondaryStrong },
  help: { ...typography.secondary, lineHeight: 20 },
});
