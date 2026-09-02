import { StyleSheet, Text, View } from "react-native";
import { radii, spacing, typography } from "../theme/tokens";
import { sourceColor } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import type { ChronologyCategory } from "../copy/chronology";

export function SourceBadge(props: {
  category: ChronologyCategory;
  label: string;
}) {
  const { colors } = useTheme();
  const label = props.label.toLowerCase();
  const color =
    label.includes("integrity")
      ? sourceColor(colors, "INTEGRITY")
      : label.includes("evidence")
        ? sourceColor(colors, "EVIDENCE")
        : props.category === "COMMERCE"
          ? sourceColor(colors, "COMMERCE")
          : props.category === "SHIPMENT"
            ? sourceColor(colors, "SHIPMENT")
            : sourceColor(colors, "PROOF");
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: colors.surface }]}>
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
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { ...typography.caption },
});
