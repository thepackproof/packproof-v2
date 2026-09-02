import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { formatBytes, formatDuration } from "../capture";

export function EvidenceCard(props: {
  title: string;
  stateLabel: string;
  durationMs?: number | null;
  byteSize?: number | null;
  hash?: string | null;
  committed?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.row}>
        <View style={[styles.thumb, { backgroundColor: colors.background }]}>
          <Ionicons name="videocam" size={22} color={props.committed ? colors.success : colors.textPrimary} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.stateLabel}</Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {[formatDuration(props.durationMs), formatBytes(props.byteSize)].filter((value) => !value.includes("unknown")).join(" · ")}
          </Text>
        </View>
      </View>
      {props.hash ? (
        <Text style={[styles.hash, { color: colors.textMuted }]} selectable>{`SHA-256 ${props.hash.slice(0, 12)}…`}</Text>
      ) : null}
    </View>
  );
}

export function ProgressState(props: { label: string; percent?: number | null; detail?: string }) {
  const { colors } = useTheme();
  const width = Math.max(0, Math.min(100, props.percent ?? 0));
  return (
    <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={props.label} accessibilityValue={{ now: width, min: 0, max: 100 }}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{props.label}</Text>
      {props.detail ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.detail}</Text> : null}
      <View style={[styles.track, { backgroundColor: colors.border }]}>
        <View style={[styles.fill, { width: `${width}%`, backgroundColor: colors.accent }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
  title: { ...typography.cardTitle },
  meta: { ...typography.secondary },
  hash: { ...typography.caption },
  progress: { gap: spacing.sm },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  fill: { height: 8 },
});
