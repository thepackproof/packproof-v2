import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SELLER_SHIPPING_STATEMENT } from "../attestation/statement";
import { useTheme } from "../theme/ThemeProvider";
import { haptic } from "../theme/haptics";
import { cinematicForScheme } from "../theme/cinematic";
import { spacing, typography } from "../theme/tokens";
import { FadeSlideIn, PressableScale, PulseScale, SuccessHalo } from "./motion";

/** This is a generic icon. It never displays or receives a person's fingerprint. */
export function SellerAttestation({ onPress, disabled = false, loading = false }: {
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { colors, scheme } = useTheme();
  const accent = cinematicForScheme(scheme);
  return <FadeSlideIn>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: accent.violet }]}>
      <View pointerEvents="none" style={[styles.accentRail, { backgroundColor: accent.violet }]} />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Confirm and submit. ${SELLER_SHIPPING_STATEMENT}`}
        accessibilityHint="Android requests a supported strong biometric, such as fingerprint or supported face authentication."
        accessibilityState={{ disabled: disabled || loading, busy: loading }}
        disabled={disabled || loading}
        onPress={() => { void haptic("medium"); onPress(); }}
        style={[styles.action, { opacity: disabled ? 0.5 : 1 }]}
      >
        <View style={styles.iconStage}>
          <SuccessHalo active={loading} color={accent.violet} style={styles.halo}><View /></SuccessHalo>
          <PulseScale active={loading} amount={1.055}>
            <View style={[styles.icon, { backgroundColor: accent.violetSoft, borderColor: accent.violet }]}>
              {loading ? <ActivityIndicator color={accent.violet} /> : <Ionicons name="finger-print-outline" size={34} color={accent.violet} />}
            </View>
          </PulseScale>
        </View>
        <Text style={[styles.kicker, { color: accent.violet }]}>SECURE ATTESTATION</Text>
        <Text style={[styles.statement, { color: colors.textPrimary }]}>{SELLER_SHIPPING_STATEMENT}</Text>
        <Text style={[styles.instruction, { color: accent.violet }]}>{loading ? "Verifying with this device…" : "Confirm and submit"}</Text>
      </PressableScale>
      <Text style={[styles.privacy, { color: colors.textSecondary }]}>Confirm with your device’s secure biometric prompt. PackProof never receives your fingerprint or face data.</Text>
    </View>
  </FadeSlideIn>;
}

const styles = StyleSheet.create({
  card: { position: "relative", overflow: "hidden", padding: spacing.lg, borderRadius: 14, borderWidth: 1, gap: spacing.md },
  accentRail: { position: "absolute", left: 0, top: 16, bottom: 16, width: 3, borderRadius: 2 },
  action: { alignItems: "center", gap: spacing.md, minHeight: 64 },
  iconStage: { width: 78, height: 78, alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", width: 68, height: 68, borderRadius: 34, borderWidth: 2 },
  icon: { width: 60, height: 60, borderRadius: 30, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  kicker: { ...typography.caption, fontSize: 11, lineHeight: 14, letterSpacing: 1.2, fontWeight: "700" },
  statement: { ...typography.body, fontWeight: "600", textAlign: "center" },
  instruction: { ...typography.secondary, fontWeight: "700", textAlign: "center" },
  privacy: { ...typography.caption, textAlign: "center", fontWeight: "400" },
});
