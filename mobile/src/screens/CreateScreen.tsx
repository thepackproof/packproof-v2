import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { marketplaceImportAvailable } from "../copy/presentation";
import { colors, radii, shadows, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";

export function CreateScreen() {
  const app = usePackProof();
  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
  }, []);
  const importReady = marketplaceImportAvailable(app.connections);

  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Create a Proof" onBack={app.goBack} />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <View style={styles.list}>
        <CreateOption
          title="Scan order or label"
          detail="Fastest"
          icon="scan-outline"
          onPress={() => app.go("scan")}
          disabled={app.busy}
        />
        <CreateOption
          title="Import purchase"
          detail={importReady ? "From a connected marketplace" : "Connect a marketplace in Account first"}
          icon="storefront-outline"
          onPress={() => {
            if (!importReady) {
              app.go("account");
              return;
            }
            void app.importPurchase();
          }}
          disabled={app.busy}
        />
        <CreateOption
          title="Enter manually"
          detail="For direct sales"
          icon="document-text-outline"
          onPress={() => {
            app.setCreateForm({
              externalReference: "",
              transactionDate: "",
              itemTitle: "",
              itemDescription: "",
              quantity: "",
              transactionValue: "",
              currency: "",
              carrier: "",
              service: "",
              trackingNumber: "",
              shipmentDate: "",
            });
            app.go("manual");
          }}
          disabled={app.busy}
        />
      </View>
      <Text style={styles.joinLabel}>Have an invitation ID?</Text>
      <FormField label="Invitation ID" value={app.invitationInput} onChangeText={app.setInvitationInput} />
      <Button
        label="Join Proof"
        variant="secondary"
        disabled={app.busy || !app.invitationInput.trim()}
        onPress={() => void app.acceptInvite(app.invitationInput.trim())}
      />
    </AppScreen>
  );
}

function CreateOption(props: {
  title: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.title}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.icon}>
        <Ionicons name={props.icon} size={26} color={colors.navy} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.detail}>{props.detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.slate} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 88,
    ...shadows.card,
  },
  pressed: { opacity: 0.92 },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.blueSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 4 },
  title: { ...typography.cardTitle, color: colors.navy },
  detail: { ...typography.secondary, color: colors.slate },
  error: { ...typography.secondary, color: colors.danger },
  joinLabel: { ...typography.secondaryStrong, color: colors.navy, marginTop: spacing.md },
});
