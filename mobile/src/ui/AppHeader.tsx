import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, typography } from "../theme/tokens";
import { IconButton } from "./Button";
import { Logo } from "./Logo";

export function AppHeader(props: {
  title?: string;
  subtitle?: string;
  showLogo?: boolean;
  onBack?: () => void;
  backLabel?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {props.onBack ? (
          <IconButton label={props.backLabel ?? "Back"} onPress={props.onBack}>
            <Ionicons name="chevron-back" size={24} color={colors.navy} />
          </IconButton>
        ) : props.showLogo ? (
          <Logo size={32} />
        ) : (
          <View style={styles.spacer} />
        )}
        <View style={styles.center}>
          {props.showLogo && !props.onBack ? <Text style={styles.brand}>PackProof</Text> : null}
          {props.title ? <Text style={styles.title}>{props.title}</Text> : null}
        </View>
        <View style={styles.right}>{props.right ?? <View style={styles.spacer} />}</View>
      </View>
      {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

export function SectionHeader(props: { title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      {props.onAction && props.actionLabel ? (
        <Text onPress={props.onAction} style={styles.action} accessibilityRole="button">
          {props.actionLabel}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", minHeight: 48 },
  center: { flex: 1, paddingHorizontal: spacing.sm },
  right: { minWidth: 48, alignItems: "flex-end" },
  spacer: { width: 48, height: 48 },
  brand: { ...typography.secondaryStrong, color: colors.slate },
  title: { ...typography.sectionTitle, color: colors.navy },
  subtitle: { ...typography.secondary, color: colors.slate },
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  sectionTitle: { ...typography.sectionTitle, color: colors.navy },
  action: { ...typography.secondaryStrong, color: colors.blue },
});
