import { useState } from "react";
import { Alert, Text } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { usePackProof } from "../app/PackProofProvider";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Ionicons } from "@expo/vector-icons";
import { Button, IconButton } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";

export function ManualCreateScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const form = app.createForm;
  const setForm = app.setCreateForm;
  const [showGrading, setShowGrading] = useState(false);
  const [gradingCount, setGradingCount] = useState("1");
  const [showDetails, setShowDetails] = useState(Boolean(app.intakeReview));
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="New Proof" onBack={app.goBack} right={<IconButton label="Share Proof" onPress={() => Alert.alert("Share Proof", app.offline ? "Connect to create a share link. Your draft is kept." : "Create this Proof to get a share link. Your draft is kept.")}><Ionicons name="share-outline" size={22} color={colors.textPrimary} /></IconButton>} />
      <ErrorBanner message={app.error} />
      <Text style={{ color:colors.textSecondary,fontSize:16,lineHeight:24 }}>Connected-store orders appear automatically in Proofs. Add another shipment here.</Text>
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
      <FormField
        label="What are you shipping?"
        value={form.itemTitle}
        onChangeText={(value) => setForm({ ...form, itemTitle: value })}
        autoCapitalize="sentences"
      />
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>Show the shipping label during your packing video. PackProof will try to read it for you.</Text>
      <Button label="Paste order details" variant="tertiary" onPress={() => app.go("intake")} />
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
      <Button label="Document a grading submission" variant="tertiary" onPress={() => setShowGrading(value => !value)} />
      {showGrading ? <><FormField label="Number of items" value={gradingCount} onChangeText={setGradingCount} keyboardType="number-pad" /><Button label="Start grading submission" variant="secondary" disabled={!/^[1-9]\d*$/.test(gradingCount)} onPress={() => void app.createGradingProof(Number(gradingCount))} /></> : null}
      <Button
        disabled={!form.itemTitle.trim()}
        label="Open camera"
        onPress={() => void app.createManualProof()}
        loading={app.busy}
      />
    </AppScreen>
  );
}
