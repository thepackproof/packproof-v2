import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";

export function DevToolsScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proof = app.proof;
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Developer tools" onBack={app.goBack} />
      <Text style={[styles.note, { color: colors.textSecondary }]}>
        These controls are hidden in production builds. They do not change Proof ownership rules.
      </Text>
      <ErrorBanner message={app.error} />
      <Button label="Refresh from server" onPress={() => void app.syncWorkspace()} disabled={app.busy} variant="secondary" />
      {app.session?.proofId ? (
        <Button
          label="Open cached Proof from server"
          onPress={() => void app.run(async () => app.openProof(app.session?.proofId as string))}
          variant="secondary"
        />
      ) : null}
      <FormField label="Invitation ID fallback" value={app.invitationInput} onChangeText={app.setInvitationInput} />
      <Button
        label="Accept invitation ID"
        onPress={() => void app.acceptInvite(app.invitationInput.trim())}
        disabled={app.busy || !app.invitationInput.trim()}
        variant="secondary"
      />
      {proof && app.role === "SELLER" ? (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Demo shipment observations</Text>
          {(
            [
              ["LABEL_CREATED", "Import label created"],
              ["CARRIER_ACCEPTED", "Import accepted"],
              ["WEIGHT_RECORDED", "Import weight"],
              ["IN_TRANSIT", "Import in transit"],
              ["OUT_FOR_DELIVERY", "Import out for delivery"],
              ["DELIVERED", "Import delivered"],
            ] as const
          ).map(([eventType, label]) => (
            <Button key={eventType} label={label} onPress={() => void app.importDemoShipment(eventType)} disabled={app.busy} variant="secondary" />
          ))}
          <Button label="Import remaining demo observations" onPress={() => void app.importDemoShipment()} disabled={app.busy} variant="secondary" />
          {app.role === "SELLER" && !proof.shipmentSync?.available ? (
            <Button label="Connect trusted demo" onPress={() => void app.connectTrustedDemo()} disabled={app.busy} variant="secondary" />
          ) : null}
        </View>
      ) : null}
      {proof ? (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Raw state</Text>
          <Text selectable style={[styles.mono, { color: colors.textPrimary }]}>{`proofId ${proof.proofId}`}</Text>
          <Text selectable style={[styles.mono, { color: colors.textPrimary }]}>{`status ${proof.status}`}</Text>
          <Text selectable style={[styles.mono, { color: colors.textPrimary }]}>{`capture ${app.captureStatus}`}</Text>
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  note: { ...typography.secondary },
  heading: { ...typography.sectionTitle },
  block: { gap: spacing.sm },
  mono: { ...typography.caption },
});
