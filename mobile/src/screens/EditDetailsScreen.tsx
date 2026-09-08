import type { ComponentProps } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { recordCorrectionState } from "../copy/record-context";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";

export function EditPurchaseScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const context = recordCorrectionState(app.proof, app.transactionDetail ?? app.proof?.transaction, app.role, Boolean(app.localCapture && app.session?.captureProofId === app.proof?.proofId));
  const locked = !context.canCorrectOrder;
  const form = app.editForm;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title={locked ? "Order details" : "Correct order details"} onBack={app.goBack} />
      <Text style={[styles.lock, { color: colors.textSecondary }]}>
        {locked ? <Ionicons name="lock-closed-outline" size={16} color={colors.textSecondary} /> : null} {context.reason}
      </Text>
      <ErrorBanner message={app.error} />
      <ContextField locked={locked} label="Item" value={form.itemTitle} onChangeText={(value) => app.setEditForm({ ...form, itemTitle: value })} autoCapitalize="sentences" />
      <ContextField locked={locked} label="Description" value={form.itemDescription} onChangeText={(value) => app.setEditForm({ ...form, itemDescription: value })} multiline autoCapitalize="sentences" />
      <ContextField locked={locked} label="Quantity" value={form.quantity} onChangeText={(value) => app.setEditForm({ ...form, quantity: value })} keyboardType="number-pad" />
      <ContextField locked={locked} label="Value" value={form.transactionValue} onChangeText={(value) => app.setEditForm({ ...form, transactionValue: value })} keyboardType="decimal-pad" />
      <ContextField locked={locked} label="Currency" value={form.currency} onChangeText={(value) => app.setEditForm({ ...form, currency: value })} autoCapitalize="characters" />
      <ContextField locked={locked} label="Order reference" value={form.externalReference} onChangeText={(value) => app.setEditForm({ ...form, externalReference: value })} />
      <ContextField locked={locked} label="Transaction date (YYYY-MM-DD)" value={form.transactionDate} onChangeText={(value) => app.setEditForm({ ...form, transactionDate: value })} />
      {locked ? null : <Button label="Save corrections" onPress={() => void app.savePurchaseDetails()} loading={app.busy} />}
    </AppScreen>
  );
}

export function EditShippingScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const context = recordCorrectionState(app.proof, app.transactionDetail ?? app.proof?.transaction, app.role, Boolean(app.localCapture && app.session?.captureProofId === app.proof?.proofId));
  const locked = !context.canCorrectShipping;
  const form = app.editForm;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title={locked ? "Shipping details" : "Correct shipping details"} onBack={app.goBack} />
      <Text style={[styles.lock, { color: colors.textSecondary }]}>{context.reason}</Text>
      <ErrorBanner message={app.error} />
      <ContextField locked={locked} label="Carrier" value={form.carrier} onChangeText={(value) => app.setEditForm({ ...form, carrier: value })} autoCapitalize="words" />
      <ContextField locked={locked} label="Service" value={form.service} onChangeText={(value) => app.setEditForm({ ...form, service: value })} autoCapitalize="words" />
      <ContextField locked={locked} label="Tracking number" value={form.trackingNumber} onChangeText={(value) => app.setEditForm({ ...form, trackingNumber: value })} />
      <ContextField locked={locked} label="Shipment date (YYYY-MM-DD)" value={form.shipmentDate} onChangeText={(value) => app.setEditForm({ ...form, shipmentDate: value })} />
      {locked ? null : <Button label="Save corrections" onPress={() => void app.saveShippingDetails()} loading={app.busy} />}
    </AppScreen>
  );
}

function ContextField({ locked, ...props }: ComponentProps<typeof FormField> & { locked: boolean }) {
  const { colors } = useTheme();
  if (!locked) return <FormField {...props} />;
  return <View style={{ gap: 4 }}><Text style={[styles.lock, { color: colors.textSecondary }]}>{props.label}</Text><Text selectable style={[styles.value, { color: colors.textPrimary }]}>{props.value || "Not provided"}</Text></View>;
}

const styles = StyleSheet.create({
  value: { ...typography.body },
  lock: { ...typography.secondary },
});
