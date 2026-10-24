import {SIGNAL_ENABLED} from "../experience/signal";
import {signalType} from "../theme/signal";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SELLER_SHIPPING_STATEMENT, SELLER_SHIPPING_STATEMENT_VERSION } from "../attestation/statement";
import { canConfirmManualReview } from "../experience/manual-review";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";

/** Android composition only. The checkbox records no attestation; the existing
 * submission owner must still obtain and validate native biometric signing. */
export function ManualReviewConfirmation({ binding, onPress, disabled = false, loading = false }: {
  binding: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const [acceptedBinding, setAcceptedBinding] = useState<string | null>(null);
  const checked = acceptedBinding === binding;
  const allowed = canConfirmManualReview({ acceptedBinding, currentBinding: binding, blocked: disabled, busy: loading });
  return <View style={styles.root}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={SELLER_SHIPPING_STATEMENT}
      accessibilityHint={`Declaration version ${SELLER_SHIPPING_STATEMENT_VERSION}. Applies to this recording and item. Secure device confirmation is a separate step.`}
      accessibilityState={{ checked, disabled: loading }} disabled={loading}
      onPress={() => setAcceptedBinding(checked ? null : binding)}
      style={({ pressed }) => [styles.declaration, { backgroundColor: pressed ? colors.surfacePressed : colors.surface, borderColor: checked ? colors.primary : colors.border }]}>
      <Ionicons name={checked ? "checkbox" : "square-outline"} size={26} color={checked ? colors.primary : colors.textSecondary} />
      <View style={styles.copy}>
        <Text style={[styles.statement, { color: colors.textPrimary }]}>{SELLER_SHIPPING_STATEMENT}</Text>
        {!SIGNAL_ENABLED && <Text style={[styles.hint, { color: colors.textSecondary }]}>Declaration version {SELLER_SHIPPING_STATEMENT_VERSION} · Applies to this recording and item.</Text>}
      </View>
    </Pressable>
    <Button label={SIGNAL_ENABLED?"Save to PackProof":"Confirm and submit"} icon={SIGNAL_ENABLED?"arrow-forward":"finger-print-outline"} disabled={!allowed} loading={loading}
      accessibilityHint="Confirm with your device’s secure biometric prompt before submission."
      onPress={() => { if (allowed) onPress(); }} haptic="medium" />
    <Text style={[styles.hint, { color: colors.textSecondary }]}>You’ll confirm with your device’s secure signing step. PackProof never receives your fingerprint or face data.</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  declaration: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: SIGNAL_ENABLED?20:12, minHeight: 76, borderWidth: 1, borderRadius: 16 },
  copy: { flex: 1, minWidth: 0, gap: 6 },
  statement: { ...signalType.small },
  hint: { ...signalType.caption },
});
