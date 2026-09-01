import { StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { fieldsLocked } from "../copy/next-action";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";

export function EditPurchaseScreen() {
  const app = usePackProof();
  const locked = fieldsLocked(app.proof?.status);
  const form = app.editForm;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Purchase details" onBack={app.goBack} />
      {locked ? (
        <Text style={styles.lock}>
          <Ionicons name="lock-closed" size={14} color={colors.green} /> Included in finalized PackProof
        </Text>
      ) : null}
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <FormField label="Item" value={form.itemTitle} onChangeText={(value) => app.setEditForm({ ...form, itemTitle: value })} editable={!locked} autoCapitalize="sentences" />
      <FormField label="Description" value={form.itemDescription} onChangeText={(value) => app.setEditForm({ ...form, itemDescription: value })} multiline editable={!locked} autoCapitalize="sentences" />
      <FormField label="Quantity" value={form.quantity} onChangeText={(value) => app.setEditForm({ ...form, quantity: value })} keyboardType="number-pad" editable={!locked} />
      <FormField label="Value" value={form.transactionValue} onChangeText={(value) => app.setEditForm({ ...form, transactionValue: value })} keyboardType="decimal-pad" editable={!locked} />
      <FormField label="Currency" value={form.currency} onChangeText={(value) => app.setEditForm({ ...form, currency: value })} autoCapitalize="characters" editable={!locked} />
      <FormField label="Order reference" value={form.externalReference} onChangeText={(value) => app.setEditForm({ ...form, externalReference: value })} editable={!locked} />
      <FormField label="Transaction date (YYYY-MM-DD)" value={form.transactionDate} onChangeText={(value) => app.setEditForm({ ...form, transactionDate: value })} editable={!locked} />
      {locked ? null : <Button label="Save purchase details" onPress={() => void app.savePurchaseDetails()} loading={app.busy} />}
    </AppScreen>
  );
}

export function EditShippingScreen() {
  const app = usePackProof();
  const locked = fieldsLocked(app.proof?.status);
  const form = app.editForm;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Shipping details" onBack={app.goBack} />
      {locked ? (
        <Text style={styles.lock}>
          Core shipping details are included in the finalized PackProof. Later carrier observations can still be appended.
        </Text>
      ) : null}
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <FormField label="Carrier" value={form.carrier} onChangeText={(value) => app.setEditForm({ ...form, carrier: value })} editable={!locked} autoCapitalize="words" />
      <FormField label="Service" value={form.service} onChangeText={(value) => app.setEditForm({ ...form, service: value })} editable={!locked} autoCapitalize="words" />
      <FormField label="Tracking number" value={form.trackingNumber} onChangeText={(value) => app.setEditForm({ ...form, trackingNumber: value })} editable={!locked} />
      <FormField label="Shipment date (YYYY-MM-DD)" value={form.shipmentDate} onChangeText={(value) => app.setEditForm({ ...form, shipmentDate: value })} editable={!locked} />
      {locked ? null : <Button label="Save shipping details" onPress={() => void app.saveShippingDetails()} loading={app.busy} />}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  lock: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
});
