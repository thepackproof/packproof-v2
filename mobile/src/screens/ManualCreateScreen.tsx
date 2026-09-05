import { useState } from "react";
import { Text } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { usePackProof } from "../app/PackProofProvider";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";

export function ManualCreateScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const form = app.createForm;
  const setForm = app.setCreateForm;
  const [showDetails, setShowDetails] = useState(Boolean(app.intakeReview));
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Enter manually" onBack={app.goBack} />
      <ErrorBanner message={app.error} />
      {app.intakeReview ? (
        <>
          <SectionHeader title="Review your order" />
          {app.intakeReview.warnings.map((warning, i) => (
            <Text
              key={i}
              style={{
                color: colors.textSecondary,
                fontSize: 14,
                lineHeight: 20,
              }}
            >
              {warning}
            </Text>
          ))}
        </>
      ) : null}
      <SectionHeader title="Purchase details" />
      <FormField
        label="Item"
        value={form.itemTitle}
        onChangeText={(value) => setForm({ ...form, itemTitle: value })}
        autoCapitalize="sentences"
      />
      <FormField
        label="Description"
        value={form.itemDescription}
        onChangeText={(value) => setForm({ ...form, itemDescription: value })}
        multiline
        autoCapitalize="sentences"
      />
      <FormField
        label="Order reference"
        value={form.externalReference}
        onChangeText={(value) => setForm({ ...form, externalReference: value })}
      />
      <SectionHeader title="Shipping details" />
      <FormField
        label="Carrier"
        value={form.carrier}
        onChangeText={(value) => setForm({ ...form, carrier: value })}
        autoCapitalize="words"
      />
      <FormField
        label="Tracking number"
        value={form.trackingNumber}
        onChangeText={(value) => setForm({ ...form, trackingNumber: value })}
      />
      <Text style={{ color: colors.textSecondary }}>
        Invite the buyer by username after creating the Proof. Only the item is required to start.
      </Text>
      <Button
        label={showDetails ? "Hide optional details" : "Add optional details"}
        variant="tertiary"
        onPress={() => setShowDetails(!showDetails)}
      />
      {showDetails ? (
        <>
          <FormField
            label="Quantity"
            value={form.quantity}
            onChangeText={(value) => setForm({ ...form, quantity: value })}
            keyboardType="number-pad"
          />
          <FormField
            label="Value"
            value={form.transactionValue}
            onChangeText={(value) => setForm({ ...form, transactionValue: value })}
            keyboardType="decimal-pad"
          />
          <FormField
            label="Currency"
            value={form.currency}
            onChangeText={(value) => setForm({ ...form, currency: value })}
            autoCapitalize="characters"
          />
          <FormField
            label="Transaction date (YYYY-MM-DD)"
            value={form.transactionDate}
            onChangeText={(value) => setForm({ ...form, transactionDate: value })}
          />
          <FormField
            label="Service"
            value={form.service}
            onChangeText={(value) => setForm({ ...form, service: value })}
            autoCapitalize="words"
          />
          <FormField
            label="Shipment date (YYYY-MM-DD)"
            value={form.shipmentDate}
            onChangeText={(value) => setForm({ ...form, shipmentDate: value })}
          />
        </>
      ) : null}
      <Button
        disabled={!form.itemTitle.trim()}
        label="Create PackProof"
        onPress={() => void app.createManualProof()}
        loading={app.busy}
      />
    </AppScreen>
  );
}
