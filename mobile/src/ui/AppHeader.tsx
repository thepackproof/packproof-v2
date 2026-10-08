import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { sizes, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { IconButton } from "./Button";
import { PressableScale } from "./motion";
import { Logo } from "./Logo";

export function AppHeader(props: {
  title?: string;
  subtitle?: string;
  showLogo?: boolean;
  onBack?: () => void;
  backLabel?: string;
  right?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {props.onBack ? (
          <IconButton label={props.backLabel ?? "Back"} onPress={props.onBack}>
            <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
          </IconButton>
        ) : props.showLogo ? (
          <Logo size={32} />
        ) : null}
        <View style={[styles.center, props.onBack || props.showLogo ? styles.centerInset : null]}>
          {props.showLogo && !props.onBack ? (
            <Text style={[styles.brand, { color: colors.textSecondary }]}>PACKPROOF</Text>
          ) : null}
          {props.title ? <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text> : null}
        </View>
        {props.right ? <View style={styles.right}>{props.right}</View> : null}
      </View>
      {props.subtitle ? <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{props.subtitle}</Text> : null}
    </View>
  );
}

export function SectionHeader(props: { title: string; actionLabel?: string; onAction?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{props.title}</Text>
      {props.onAction && props.actionLabel ? (
        <PressableScale onPress={props.onAction} accessibilityRole="button" style={styles.actionTarget}><Text style={[styles.action, { color: colors.accentText }]}>{props.actionLabel}</Text></PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", minHeight: sizes.touch },
  center: { flex: 1, minWidth: 0 },
  centerInset: { paddingHorizontal: spacing.sm },
  right: { minWidth: sizes.touch, alignItems: "flex-end", marginLeft: spacing.sm },
  brand: { ...typography.finePrint, fontFamily: "Inter-SemiBold", fontWeight: "600", letterSpacing: 1.2, marginBottom: spacing.xs },
  title: { ...typography.pageTitle },
  subtitle: { ...typography.secondary },
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  sectionTitle: { ...typography.sectionTitle, flexShrink: 1 },
  actionTarget: { minHeight: sizes.touch, minWidth: sizes.touch, justifyContent: "center", paddingHorizontal: spacing.xs },
  action: { ...typography.secondaryStrong },
});
