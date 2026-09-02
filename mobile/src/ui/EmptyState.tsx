import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";

export function EmptyState(props: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} accessibilityRole="summary">
      <Ionicons name={props.icon ?? "cube-outline"} size={36} color={colors.textSecondary} />
      <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{props.body}</Text>
      {props.onAction && props.actionLabel ? <Button label={props.actionLabel} onPress={props.onAction} /> : null}
    </View>
  );
}

export function OfflineBanner(props: { visible: boolean; message?: string }) {
  const { colors } = useTheme();
  if (!props.visible) {
    return null;
  }
  return (
    <View
      style={[styles.banner, { backgroundColor: colors.warningSoft, borderColor: colors.warningSoftBorder }]}
      accessibilityRole="alert"
    >
      <Ionicons name="cloud-offline-outline" size={16} color={colors.textPrimary} />
      <Text style={[styles.bannerText, { color: colors.textPrimary }]}>{props.message ?? "Offline"}</Text>
    </View>
  );
}

export function ErrorBanner(props: { message: string | null; technical?: string | null }) {
  const { colors } = useTheme();
  if (!props.message) {
    return null;
  }
  return (
    <View
      style={[styles.banner, { backgroundColor: colors.errorSoft, borderColor: colors.errorMuted }]}
      accessibilityRole="alert"
    >
      <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
      <View style={styles.bannerCopy}>
        <Text style={[styles.bannerText, { color: colors.error }]}>{props.message}</Text>
        {__DEV__ && props.technical ? (
          <Text style={[styles.technical, { color: colors.textMuted }]} accessibilityLabel="Technical details">
            {props.technical}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxxl },
  title: { ...typography.sectionTitle, textAlign: "center" },
  body: { ...typography.secondary, textAlign: "center" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerCopy: { flex: 1, gap: 4 },
  bannerText: { ...typography.secondaryStrong, flex: 1 },
  technical: { ...typography.caption },
});
