import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { statusTone, type StatusTone } from "../copy/status-tone";
export { statusTone } from "../copy/status-tone";
import type { IntegrityState } from "../copy/status";

export function StatusBadge(props: {
  label: string;
  tone?: StatusTone;
}) {
  const { colors } = useTheme();
  const tone = props.tone ?? statusTone(props.label);
  const palette =
    tone === "info"
      ? { background: colors.accentSoft, border: colors.accentSoftBorder, text: colors.accentText }
      : tone === "success"
        ? { background: colors.successSoft, border: colors.successSoftBorder, text: colors.successText }
        : tone === "warning"
          ? { background: colors.warningSoft, border: colors.warningSoftBorder, text: colors.warningText }
          : tone === "error"
            ? { background: colors.errorSoft, border: colors.errorMuted, text: colors.error }
            : { background: colors.surfaceElevated, border: colors.border, text: colors.textSecondary };
  return (
    <View style={[styles.badge, { backgroundColor: palette.background, borderColor: palette.border }]}>
      <Ionicons name={tone === "success" ? "checkmark-circle-outline" : tone === "error" ? "alert-circle-outline" : tone === "warning" ? "alert-outline" : tone === "info" ? "information-circle-outline" : "time-outline"} size={16} color={palette.text} />
      <Text style={[styles.label, { color: tone === "success" ? colors.textPrimary : palette.text }]}>{props.label}</Text>
    </View>
  );
}

export function IntegrityMark(props: { state: IntegrityState; label?: string }) {
  const { colors } = useTheme();
  if (props.state === "none") {
    return null;
  }
  return (
    <View
      style={styles.integrity}
      accessibilityLabel={props.label ?? (props.state === "finalized" ? "Sealed record" : "Evidence secured")}
    >
      <Ionicons
        name={props.state === "finalized" ? "shield-checkmark" : "checkmark-circle"}
        size={18}
        color={colors.success}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
  },
  label: { ...typography.caption },
  integrity: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
});
