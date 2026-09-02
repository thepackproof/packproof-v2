import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TimelineEventModel, TimelineIcon } from "../copy/chronology";
import { colors, spacing, typography } from "../theme/tokens";
import { sourceColors } from "../theme/tokens";
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
  if (props.events.length === 0) {
    return <Text style={styles.empty}>{props.emptyLabel ?? "No history is available yet."}</Text>;
  }
  return (
    <View style={styles.list}>
      {props.events.map((event, index) => (
        <TimelineEvent
          key={event.id}
          event={event}
          last={index === props.events.length - 1}
          onPress={() => props.onSelect(event)}
        />
      ))}
    </View>
  );
}

export function TimelineEvent(props: {
  event: TimelineEventModel;
  last?: boolean;
  onPress: () => void;
}) {
  const source = props.event.sourceLabel.toLowerCase();
  const color =
    source.includes("integrity")
      ? sourceColors.INTEGRITY
      : source.includes("evidence")
        ? sourceColors.EVIDENCE
        : props.event.category === "COMMERCE"
          ? sourceColors.COMMERCE
          : props.event.category === "SHIPMENT"
            ? sourceColors.SHIPMENT
            : sourceColors.PROOF;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.event.title}, ${props.event.timeLabel}`}
      style={styles.row}
    >
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: color }]}>
          <Ionicons
            name={ICONS[props.event.icon]}
            size={14}
            color={props.event.icon === "check" || props.event.icon === "lock" ? colors.green : colors.white}
          />
        </View>
        {props.last ? null : <View style={styles.line} />}
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{props.event.title}</Text>
        {props.event.description ? <Text style={styles.meta}>{props.event.description}</Text> : null}
        <Text style={styles.time}>
          {[props.event.dateLabel, props.event.timeLabel].filter(Boolean).join(" • ")}
        </Text>
        {props.event.afterFinalization ? (
          <Text style={styles.after}>Recorded after finalization. Did not change the sealed record.</Text>
        ) : null}
        <SourceBadge category={props.event.category} label={props.event.sourceLabel} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0 },
  empty: { ...typography.secondary, color: colors.slate },
  row: { flexDirection: "row", gap: spacing.md, minHeight: 64 },
  rail: { width: 28, alignItems: "center" },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.navy,
  },
  line: {
    flex: 1,
    width: 2,
    backgroundColor: colors.border,
    marginVertical: 4,
  },
  body: { flex: 1, paddingBottom: spacing.xl, gap: 4 },
  title: { ...typography.bodyStrong, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  time: { ...typography.caption, color: colors.textMuted },
  after: { ...typography.caption, color: colors.slate },
});
