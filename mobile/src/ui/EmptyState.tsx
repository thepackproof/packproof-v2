import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, typography } from "../theme/tokens";
import { Button } from "./Button";

export function EmptyState(props: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="summary">
      <Ionicons name={props.icon ?? "cube-outline"} size={36} color={colors.slate} />
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.body}>{props.body}</Text>
      {props.onAction && props.actionLabel ? <Button label={props.actionLabel} onPress={props.onAction} /> : null}
    </View>
  );
}

export function OfflineBanner(props: { visible: boolean; message?: string }) {
  if (!props.visible) {
    return null;
  }
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Ionicons name="cloud-offline-outline" size={16} color={colors.navy} />
      <Text style={styles.bannerText}>{props.message ?? "Offline"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxxl },
  title: { ...typography.sectionTitle, color: colors.navy, textAlign: "center" },
  body: { ...typography.secondary, color: colors.slate, textAlign: "center" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "#FFF6E8",
    borderColor: "#F0D7A8",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerText: { ...typography.secondaryStrong, color: colors.navy, flex: 1 },
});
