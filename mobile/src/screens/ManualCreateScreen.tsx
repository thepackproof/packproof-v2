import { StyleSheet, Text } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader, SectionHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";

export function ManualCreateScreen() {
  const app = usePackProof();
  const form = app.createForm;
  const setForm = app.setCreateForm;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Enter manually" onBack={app.goBack} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <SectionHeader title="Purchase details" />
      <FormField label="Item" value={form.itemTitle} onChangeText={(value) => setForm({ ...form, itemTitle: value })} autoCapitalize="sentences" />
      <FormField label="Description" value={form.itemDescription} onChangeText={(value) => setForm({ ...form, itemDescription: value })} multiline autoCapitalize="sentences" />
      <FormField label="Quantity" value={form.quantity} onChangeText={(value) => setForm({ ...form, quantity: value })} keyboardType="number-pad" />
      <FormField label="Value" value={form.transactionValue} onChangeText={(value) => setForm({ ...form, transactionValue: value })} keyboardType="decimal-pad" />
      <FormField label="Currency" value={form.currency} onChangeText={(value) => setForm({ ...form, currency: value })} autoCapitalize="characters" />
      <FormField label="Order reference" value={form.externalReference} onChangeText={(value) => setForm({ ...form, externalReference: value })} />
      <FormField label="Transaction date (YYYY-MM-DD)" value={form.transactionDate} onChangeText={(value) => setForm({ ...form, transactionDate: value })} />
      <SectionHeader title="Shipping details" />
      <FormField label="Carrier" value={form.carrier} onChangeText={(value) => setForm({ ...form, carrier: value })} autoCapitalize="words" />
      <FormField label="Service" value={form.service} onChangeText={(value) => setForm({ ...form, service: value })} autoCapitalize="words" />
      <FormField label="Tracking number" value={form.trackingNumber} onChangeText={(value) => setForm({ ...form, trackingNumber: value })} />
      <FormField label="Shipment date (YYYY-MM-DD)" value={form.shipmentDate} onChangeText={(value) => setForm({ ...form, shipmentDate: value })} />
      <Button label="Create PackProof" onPress={() => void app.createManualProof()} loading={app.busy} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  error: { ...typography.secondary, color: colors.danger },
});
