import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SELLER_SHIPPING_STATEMENT } from "../attestation/statement";
import { useTheme } from "../theme/ThemeProvider";
import { haptic } from "../theme/haptics";
import { spacing, typography } from "../theme/tokens";
import { PressableScale } from "./motion";

/** This is a generic icon. It never displays or receives a person's fingerprint. */
export function SellerAttestation({ onPress, disabled = false, loading = false }: {
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Confirm and submit. ${SELLER_SHIPPING_STATEMENT}`}
      accessibilityHint="Android requests a supported strong biometric, such as fingerprint or supported face authentication."
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={() => { void haptic("light"); onPress(); }}
      style={[styles.action, { opacity: disabled ? 0.5 : 1 }]}
    >
      <View style={[styles.icon, { backgroundColor: colors.accentSoft }]}>
        {loading ? <ActivityIndicator color={colors.accentText} /> : <Ionicons name="finger-print-outline" size={44} color={colors.accentText} />}
      </View>
      <Text style={[styles.statement, { color: colors.textPrimary }]}>{SELLER_SHIPPING_STATEMENT}</Text>
      <Text style={[styles.instruction, { color: colors.accentText }]}>{loading ? "Preparing attestation…" : "Confirm and submit"}</Text>
    </PressableScale>
    <Text style={[styles.privacy, { color: colors.textSecondary }]}>Android requests a supported strong biometric. PackProof receives a signed statement, never biometric images or templates.</Text>
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, borderRadius: 18, borderWidth: 1, gap: spacing.md },
  action: { alignItems: "center", gap: spacing.md, minHeight: 64 },
  icon: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  statement: { ...typography.body, fontWeight: "600", textAlign: "center" },
  instruction: { ...typography.secondary, fontWeight: "600", textAlign: "center" },
  privacy: { ...typography.caption, textAlign: "center" },
});
