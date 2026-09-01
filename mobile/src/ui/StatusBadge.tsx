import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing, typography } from "../theme/tokens";
import type { IntegrityState } from "../copy/status";

export function StatusBadge(props: {
  label: string;
  tone?: "neutral" | "info" | "success" | "warning";
}) {
  const tone = props.tone ?? "neutral";
  return (
    <View
      style={[
        styles.badge,
        tone === "info" ? styles.info : null,
        tone === "success" ? styles.success : null,
        tone === "warning" ? styles.warning : null,
      ]}
    >
      <Text
        style={[
          styles.label,
          tone === "info" ? styles.infoText : null,
          tone === "success" ? styles.successText : null,
          tone === "warning" ? styles.warningText : null,
        ]}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function IntegrityMark(props: { state: IntegrityState; label?: string }) {
  if (props.state === "none") {
    return null;
  }
  return (
    <View style={styles.integrity} accessibilityLabel={props.label ?? (props.state === "finalized" ? "Sealed record" : "Evidence secured")}>
      <Ionicons
        name={props.state === "finalized" ? "shield-checkmark" : "checkmark-circle"}
        size={18}
        color={colors.green}
      />
    </View>
  );
}

export function statusTone(statusLabel: string): "neutral" | "info" | "success" | "warning" {
  const value = statusLabel.toLowerCase();
  if (value.includes("completed") || value.includes("secured") || value.includes("delivered") || value.includes("sealed")) {
    return "success";
  }
  if (value.includes("transit") || value.includes("shipping") || value.includes("uploading") || value.includes("securing")) {
    return "info";
  }
  if (value.includes("waiting") || value.includes("offline") || value.includes("attention")) {
    return "warning";
  }
  return "neutral";
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    backgroundColor: colors.background,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  info: { backgroundColor: colors.blueSoft, borderColor: "#C5E8F6" },
  success: { backgroundColor: colors.greenSoft, borderColor: "#B7E8CB" },
  warning: { backgroundColor: "#FFF6E8", borderColor: "#F0D7A8" },
  label: { ...typography.caption, color: colors.navy },
  infoText: { color: "#0B6F99" },
  successText: { color: "#0A8A4B" },
  warningText: { color: "#8A5A10" },
  integrity: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
});
