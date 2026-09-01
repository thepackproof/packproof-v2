import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { colors, radii, shadows, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";

const OPTIONS = [
  {
    id: "scan" as const,
    title: "Scan order or label",
    detail: "Fastest",
    icon: "scan-outline" as const,
  },
  {
    id: "import" as const,
    title: "Import purchase",
    detail: "From a connected marketplace",
    icon: "storefront-outline" as const,
  },
  {
    id: "manual" as const,
    title: "Enter manually",
    detail: "For direct sales",
    icon: "document-text-outline" as const,
  },
];

export function CreateScreen() {
  const app = usePackProof();
  return (
    <AppScreen extraBottom={24} bottomInset={false}>
      <AppHeader showLogo title="Create a PackProof" />
      {app.error ? <Text style={styles.error}>{app.error}</Text> : null}
      <View style={styles.list}>
        {OPTIONS.map((option) => (
          <Pressable
            key={option.id}
            onPress={() => {
              if (option.id === "scan") {
                app.go("scan");
                return;
              }
              if (option.id === "import") {
                void app.importPurchase();
                return;
              }
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
            accessibilityRole="button"
            accessibilityLabel={option.title}
            style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
          >
            <View style={styles.icon}>
              <Ionicons name={option.icon} size={26} color={colors.navy} />
            </View>
            <View style={styles.copy}>
              <Text style={styles.title}>{option.title}</Text>
              <Text style={styles.detail}>{option.detail}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.slate} />
          </Pressable>
        ))}
      </View>
    </AppScreen>
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
});
