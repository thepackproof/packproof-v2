import { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion } from "../theme/motion";
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

export function ProgressState(props: { label: string; percent?: number | null; detail?: string; showLabel?: boolean }) {
  const { colors, reducedMotion } = useTheme();
  const known = typeof props.percent === "number" && Number.isFinite(props.percent);
  const percent = known ? Math.max(0, Math.min(100, props.percent!)) : 0;
  const progress = useRef(new Animated.Value(percent / 100)).current;
  useEffect(() => {
    if (reducedMotion || !known) { progress.setValue(percent / 100); return; }
    // Interpolate only observed bytes. No timer advances or manufactures progress.
    const animation = Animated.timing(progress, {
      toValue: percent / 100, duration: motion.duration.normal, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [known, percent, progress, reducedMotion]);
  return (
    <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={props.label}
      accessibilityValue={known ? { now: percent, min: 0, max: 100 } : { text: "In progress" }}>
      <View style={styles.progressHeading}>
        {props.showLabel !== false ? <Text style={[styles.progressLabel, { color: colors.textPrimary }]}>{props.label}</Text> : null}
        {known ? <Text style={[styles.percent, { color: colors.textSecondary }]}>{Math.round(percent)}%</Text>
          : reducedMotion ? <Ionicons name="hourglass-outline" size={18} color={colors.accent} />
            : <ActivityIndicator size="small" color={colors.accent} />}
      </View>
      {props.detail ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.detail}</Text> : null}
      {known ? <View style={[styles.track, { backgroundColor: colors.surfaceElevated }]}>
        <Animated.View style={[styles.fill, { backgroundColor: colors.accent, transform: [{ scaleX: progress }] }]} />
      </View> : null}
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
  fill: { height: 8, width: "100%", borderRadius: 4, transformOrigin: "left center" },
  progressHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  progressLabel: { ...typography.cardTitle, flex: 1 },
  percent: { ...typography.caption, marginLeft: "auto", fontVariant: ["tabular-nums"] },
});
