import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { formatBytes, formatDuration } from "../capture";

export function EvidenceCard(props: {
  title: string;
  stateLabel: string;
  durationMs?: number | null;
  byteSize?: number | null;
  hash?: string | null;
  committed?: boolean;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.thumb}>
          <Ionicons name="videocam" size={22} color={props.committed ? colors.green : colors.navy} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.meta}>{props.stateLabel}</Text>
          <Text style={styles.meta}>
            {[formatDuration(props.durationMs), formatBytes(props.byteSize)].filter((value) => !value.includes("unknown")).join(" · ")}
          </Text>
        </View>
      </View>
      {props.hash ? <Text style={styles.hash} selectable>{`SHA-256 ${props.hash.slice(0, 12)}…`}</Text> : null}
    </View>
  );
}

export function ProgressState(props: { label: string; percent?: number | null; detail?: string }) {
  const width = Math.max(0, Math.min(100, props.percent ?? 0));
  return (
    <View style={styles.progress} accessibilityLabel={props.label}>
      <Text style={styles.title}>{props.label}</Text>
      {props.detail ? <Text style={styles.meta}>{props.detail}</Text> : null}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${width}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
  title: { ...typography.cardTitle, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  hash: { ...typography.caption, color: colors.textMuted },
  progress: { gap: spacing.sm },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: "hidden" },
  fill: { height: 8, backgroundColor: colors.blue },
});
