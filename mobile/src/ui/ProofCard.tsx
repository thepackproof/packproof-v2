import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ProofCardModel } from "../copy/presentation";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { StatusBadge, statusTone } from "./StatusBadge";
import { PressableScale } from "./motion";

export function ProofCard(props: {
  model: ProofCardModel;
  onPress: () => void;
  cta?: string;
}) {
  const { colors, shadows } = useTheme();
  return (
    <PressableScale
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.model.title}. ${props.model.statusLabel}`}
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          ...shadows.card,
        },
      ]}
    >
      {props.model.thumbnailUri ? (
        <Image source={{ uri: props.model.thumbnailUri }} style={[styles.thumb, { backgroundColor: colors.background }]} />
      ) : (
        <View
          style={[styles.thumbFallback, { backgroundColor: colors.background }]}
          accessibilityElementsHidden
        >
          <Ionicons name="cube-outline" size={22} color={colors.textSecondary} />
        </View>
      )}
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={2}>
          {props.model.title}
        </Text>
        {props.model.priceLabel ? <Text style={[styles.price, { color: colors.textPrimary }]}>{props.model.priceLabel}</Text> : null}
        <StatusBadge label={props.model.statusLabel} tone={statusTone(props.model.statusLabel)} />
        <View style={styles.metaRow}>
          {props.model.shipping ? (
            <>
              <Ionicons name="car-outline" size={12} color={colors.textSecondary} />
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.model.shipping}</Text>
            </>
          ) : null}
          {props.model.shipping && props.model.dateLabel ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]}>•</Text>
          ) : null}
          {props.model.dateLabel ? (
            <>
              <Ionicons name="calendar-outline" size={12} color={colors.textSecondary} />
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.model.dateLabel}</Text>
            </>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </PressableScale>
  );
}

export function InfoCard(props: { children: ReactNode; onPress?: () => void }) {
  const { colors, shadows } = useTheme();
  const cardStyle = [
    styles.info,
    { backgroundColor: colors.surface, borderColor: colors.border, ...shadows.card },
  ];
  if (props.onPress) {
    return (
      <PressableScale onPress={props.onPress} style={cardStyle}>
        {props.children}
      </PressableScale>
    );
  }
  return <View style={cardStyle}>{props.children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    flexDirection: "row",
    alignItems: "center",
  },
  info: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  thumb: { width: 56, height: 56, borderRadius: radii.md },
  thumbFallback: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 6 },
  title: { ...typography.cardTitle },
  price: { ...typography.bodyStrong },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  meta: { ...typography.caption },
});
