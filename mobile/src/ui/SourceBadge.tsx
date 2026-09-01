import { StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { sourceColors } from "../theme/tokens";
import type { ChronologyCategory } from "../copy/chronology";

export function SourceBadge(props: {
  category: ChronologyCategory;
  label: string;
}) {
  const color =
    props.category === "COMMERCE"
      ? sourceColors.COMMERCE
      : props.category === "SHIPMENT"
        ? sourceColors.SHIPMENT
        : sourceColors.PROOF;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: colors.white,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { ...typography.caption },
});
