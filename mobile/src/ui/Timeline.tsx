import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TimelineEventModel, TimelineIcon } from "../copy/chronology";
import { spacing, typography, sourceColor } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion, shouldUseLargeMotion } from "../theme/motion";
import { SourceBadge } from "./SourceBadge";

const ICONS: Record<TimelineIcon, keyof typeof Ionicons.glyphMap> = {
  created: "shield-outline",
  person: "person-outline",
  commerce: "bag-handle-outline",
  package: "cube-outline",
  video: "videocam-outline",
  check: "checkmark-circle",
  lock: "lock-closed",
  truck: "car-outline",
  event: "ellipse-outline",
};

export function Timeline(props: {
  events: TimelineEventModel[];
  emptyLabel?: string;
  onSelect: (event: TimelineEventModel) => void;
}) {
  const { colors, reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!shouldUseLargeMotion(reducedMotion) || props.events.length === 0) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.35);
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.duration.slow,
      useNativeDriver: true,
    }).start();
  }, [opacity, props.events.length, reducedMotion]);

  if (props.events.length === 0) {
    return <Text style={[styles.empty, { color: colors.textSecondary }]}>{props.emptyLabel ?? "No history is available yet."}</Text>;
  }
  return (
    <Animated.View style={[styles.list, { opacity }]} accessibilityLabel="Proof record timeline">
      {props.events.map((event, index) => (
        <TimelineEvent
          key={event.id}
          event={event}
          last={index === props.events.length - 1}
          onPress={() => props.onSelect(event)}
        />
      ))}
    </Animated.View>
  );
}

export function TimelineEvent(props: {
  event: TimelineEventModel;
  last?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const source = props.event.sourceLabel.toLowerCase();
  const color =
    source.includes("integrity")
      ? sourceColor(colors, "INTEGRITY")
      : source.includes("evidence")
        ? sourceColor(colors, "EVIDENCE")
        : props.event.category === "COMMERCE"
          ? sourceColor(colors, "COMMERCE")
          : props.event.category === "SHIPMENT"
            ? sourceColor(colors, "SHIPMENT")
            : sourceColor(colors, "PROOF");
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.event.title}, ${props.event.timeLabel}${props.event.afterFinalization ? ". Recorded after finalization" : ""}`}
      style={styles.row}
    >
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: color }]}>
          <Ionicons name={ICONS[props.event.icon]} size={14} color="#FFFFFF" />
        </View>
        {props.last ? null : <View style={[styles.line, { backgroundColor: colors.divider }]} />}
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{props.event.title}</Text>
        {props.event.description ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.event.description}</Text> : null}
        <Text style={[styles.time, { color: colors.textMuted }]}>
          {[props.event.dateLabel, props.event.timeLabel].filter(Boolean).join(" • ")}
        </Text>
        {props.event.afterFinalization ? (
          <Text style={[styles.after, { color: colors.textSecondary }]}>
            Recorded after finalization. Did not change the sealed record.
          </Text>
        ) : null}
        <SourceBadge category={props.event.category} label={props.event.sourceLabel} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0 },
  empty: { ...typography.secondary },
  row: { flexDirection: "row", gap: spacing.md, minHeight: 64 },
  rail: { width: 28, alignItems: "center" },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  line: {
    flex: 1,
    width: 2,
    marginVertical: 4,
  },
  body: { flex: 1, paddingBottom: spacing.xl, gap: 4 },
  title: { ...typography.bodyStrong },
  meta: { ...typography.secondary },
  time: { ...typography.caption },
  after: { ...typography.caption },
});
