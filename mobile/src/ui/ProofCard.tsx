import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ProofCardModel } from "../copy/presentation";
import { colors, radii, shadows, spacing, typography } from "../theme/tokens";
import { IntegrityMark, StatusBadge, statusTone } from "./StatusBadge";

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
      <View style={styles.top}>
        <Text style={styles.title}>{props.model.title}</Text>
        <IntegrityMark state={props.model.integrity} />
      </View>
      {props.model.orderRef ? <Text style={styles.meta}>{props.model.orderRef}</Text> : null}
      <View style={styles.row}>
        <StatusBadge label={props.model.statusLabel} tone={statusTone(props.model.statusLabel)} />
        {props.model.roleLabel ? <Text style={styles.role}>{props.model.roleLabel}</Text> : null}
      </View>
      <View style={styles.bottom}>
        <Text style={styles.meta}>{[props.model.shipping, props.model.dateLabel].filter(Boolean).join(" · ")}</Text>
        {props.cta ? (
          <View style={styles.cta}>
            <Text style={styles.ctaText}>{props.cta}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.blue} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function InfoCard(props: { children: ReactNode; onPress?: () => void }) {
  if (props.onPress) {
    return (
      <Pressable onPress={props.onPress} style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}>
        {props.children}
      </Pressable>
    );
  }
  return <View style={styles.card}>{props.children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.card,
  },
  pressed: { opacity: 0.92 },
  top: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.sm },
  title: { ...typography.cardTitle, color: colors.navy, flex: 1 },
  meta: { ...typography.secondary, color: colors.slate },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  role: { ...typography.caption, color: colors.slate },
  bottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  cta: { flexDirection: "row", alignItems: "center", gap: 4 },
  ctaText: { ...typography.secondaryStrong, color: colors.blue },
});
