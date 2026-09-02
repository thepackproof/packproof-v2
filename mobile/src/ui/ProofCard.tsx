import type { ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ProofCardModel } from "../copy/presentation";
import { colors, radii, shadows, spacing, typography } from "../theme/tokens";
import { StatusBadge, statusTone } from "./StatusBadge";

export function ProofCard(props: {
  model: ProofCardModel;
  onPress: () => void;
  cta?: string;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.model.title}. ${props.model.statusLabel}`}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      {props.model.thumbnailUri ? (
        <Image source={{ uri: props.model.thumbnailUri }} style={styles.thumb} />
      ) : (
        <View style={styles.thumbFallback} accessibilityElementsHidden>
          <Ionicons name="cube-outline" size={22} color={colors.slate} />
        </View>
      )}
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {props.model.title}
        </Text>
        {props.model.priceLabel ? <Text style={styles.price}>{props.model.priceLabel}</Text> : null}
        <StatusBadge label={props.model.statusLabel} tone={statusTone(props.model.statusLabel)} />
        <View style={styles.metaRow}>
          {props.model.shipping ? (
            <>
              <Ionicons name="car-outline" size={12} color={colors.slate} />
              <Text style={styles.meta}>{props.model.shipping}</Text>
            </>
          ) : null}
          {props.model.shipping && props.model.dateLabel ? <Text style={styles.meta}>•</Text> : null}
          {props.model.dateLabel ? (
            <>
              <Ionicons name="calendar-outline" size={12} color={colors.slate} />
              <Text style={styles.meta}>{props.model.dateLabel}</Text>
            </>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

export function InfoCard(props: { children: ReactNode; onPress?: () => void }) {
  if (props.onPress) {
    return (
      <Pressable onPress={props.onPress} style={({ pressed }) => [styles.info, pressed ? styles.pressed : null]}>
        {props.children}
      </Pressable>
    );
  }
  return <View style={styles.info}>{props.children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    ...shadows.card,
  },
  info: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.card,
  },
  pressed: { opacity: 0.92 },
  thumb: { width: 56, height: 56, borderRadius: radii.md, backgroundColor: colors.background },
  thumbFallback: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 6 },
  title: { ...typography.cardTitle, color: colors.navy },
  price: { ...typography.bodyStrong, color: colors.navy },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  meta: { ...typography.caption, color: colors.slate },
});
