import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { marketplaceImportAvailable } from "../copy/presentation";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { ErrorBanner } from "../ui/EmptyState";
import { PressableScale } from "../ui/motion";

export function CreateScreen() {
  const app = usePackProof();
  const { colors, shadows } = useTheme();
  const [showInviteId, setShowInviteId] = useState(false);
  const [showGrading, setShowGrading] = useState(false);
  const [gradingItemCount, setGradingItemCount] = useState("1");
  useEffect(() => {
    void app.loadConnections().catch(() => undefined);
  }, []);
  const importReady = marketplaceImportAvailable(app.connections);

  return (
    <AppScreen extraBottom={24}>
      <AppHeader title="Create a Proof" onBack={app.goBack} />
      <ErrorBanner message={app.error} />
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
        <CreateOption
          title="Grading submission"
          detail="Document items for grading custody"
          icon="albums-outline"
          onPress={() => setShowGrading((value) => !value)}
          disabled={app.busy}
        />
      </View>
      {showGrading ? (
        <View style={[styles.fallback, { borderColor: colors.border, backgroundColor: colors.surface, ...shadows.card }]}>
          <Text style={[styles.fallbackCopy, { color: colors.textSecondary }]}>
            How many items are in this submission?
          </Text>
          <FormField
            label="Item count"
            value={gradingItemCount}
            onChangeText={setGradingItemCount}
            keyboardType="number-pad"
          />
          <Button
            label="Create grading Proof"
            loading={app.busy}
            onPress={() => {
              const parsed = Number.parseInt(gradingItemCount.trim(), 10);
              const itemCount = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
              void app.createGradingProof(itemCount);
            }}
          />
        </View>
      ) : null}
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        Invite a buyer by PackProof username from the Proof after it's created. Pending invitations appear in My Proofs.
      </Text>
      <Button
        label={showInviteId ? "Hide invitation ID" : "I have an invitation ID"}
        variant="tertiary"
        onPress={() => setShowInviteId((value) => !value)}
      />
      {showInviteId ? (
        <View style={[styles.fallback, { borderColor: colors.border, backgroundColor: colors.surface, ...shadows.card }]}>
          <Text style={[styles.fallbackCopy, { color: colors.textSecondary }]}>
            Use this only if you were given an invitation ID. Ordinary collaboration uses PackProof usernames.
          </Text>
          <FormField label="Invitation ID" value={app.invitationInput} onChangeText={app.setInvitationInput} />
          <Button
            label="Join Proof"
            variant="secondary"
            disabled={app.busy || !app.invitationInput.trim()}
            onPress={() => void app.acceptInvite(app.invitationInput.trim())}
          />
        </View>
      ) : null}
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
  const { colors, shadows } = useTheme();
  return (
    <PressableScale
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={`${props.title}. ${props.detail}`}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          ...shadows.card,
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name={props.icon} size={26} color={colors.textPrimary} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
        <Text style={[styles.detail, { color: colors.textSecondary }]}>{props.detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 88,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 4 },
  title: { ...typography.cardTitle },
  detail: { ...typography.secondary },
  hint: { ...typography.secondary },
  fallback: { gap: spacing.md, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg },
  fallbackCopy: { ...typography.secondary },
});
