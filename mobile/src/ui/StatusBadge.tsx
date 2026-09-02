import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import type { IntegrityState } from "../copy/status";

export function StatusBadge(props: {
  label: string;
  tone?: "neutral" | "info" | "success" | "warning";
}) {
  const { colors } = useTheme();
  const tone = props.tone ?? "neutral";
  const palette =
    tone === "info"
      ? { background: colors.accentSoft, border: colors.accentSoftBorder, text: colors.accentText }
      : tone === "success"
        ? { background: colors.successSoft, border: colors.successSoftBorder, text: colors.successText }
        : tone === "warning"
          ? { background: colors.warningSoft, border: colors.warningSoftBorder, text: colors.warningText }
          : { background: colors.background, border: colors.border, text: colors.textPrimary };
  return (
    <View style={[styles.badge, { backgroundColor: palette.background, borderColor: palette.border }]}>
      <Text style={[styles.label, { color: palette.text }]}>{props.label}</Text>
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

export function statusTone(statusLabel: string): "neutral" | "info" | "success" | "warning" {
  const value = statusLabel.toLowerCase();
  if (
    value.includes("completed") ||
    value.includes("secured") ||
    value.includes("delivered") ||
    value.includes("sealed") ||
    value.includes("finalized") ||
    value.includes("awaiting shipment")
  ) {
    return "success";
  }
  if (
    value.includes("packing") ||
    value.includes("evidence") ||
    value.includes("transit") ||
    value.includes("shipping") ||
    value.includes("uploading") ||
    value.includes("securing") ||
    value.includes("invitation")
  ) {
    return "info";
  }
  if (value.includes("waiting") || value.includes("offline") || value.includes("attention") || value.includes("needed")) {
    return "warning";
  }
  return "neutral";
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
  },
  label: { ...typography.caption },
  integrity: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
});
