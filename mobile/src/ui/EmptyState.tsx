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
    <View style={[styles.wrap, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityRole="summary">
      <View style={[styles.icon, { backgroundColor: colors.surfaceElevated }]} accessibilityElementsHidden>
        <Ionicons name={props.icon ?? "cube-outline"} size={26} color={colors.textSecondary} />
      </View>
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
      <Ionicons name="cloud-offline-outline" size={16} color={colors.warningText} />
      <Text style={[styles.bannerText, { color: colors.warningText }]}>{props.message ?? "Offline"}</Text>
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
  wrap: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xl, borderWidth: 1, borderRadius: radii.lg },
  icon: { alignItems: "center", justifyContent: "center", width: 48, height: 48, borderRadius: radii.lg, marginBottom: spacing.xs },
  title: { ...typography.cardTitle, textAlign: "center" },
  body: { ...typography.secondary, textAlign: "center", maxWidth: 360 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerCopy: { flex: 1, gap: 4 },
  bannerText: { ...typography.secondaryStrong, flex: 1 },
  technical: { ...typography.caption },
});
