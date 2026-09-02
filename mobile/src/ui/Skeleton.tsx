import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { radii } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion, shouldUseLargeMotion } from "../theme/motion";

export function SkeletonBlock(props: { height?: number; width?: number | `${number}%`; radius?: number }) {
  const { colors, reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (!shouldUseLargeMotion(reducedMotion)) {
      opacity.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.85, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.block,
        {
          height: props.height ?? 16,
          width: props.width ?? "100%",
          borderRadius: props.radius ?? radii.sm,
          backgroundColor: colors.surfacePressed,
          opacity,
        },
      ]}
    />
  );
}

export function ProofCardSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityLabel="Loading Proofs">
      <SkeletonBlock height={56} width={56} radius={12} />
      <View style={styles.copy}>
        <SkeletonBlock height={16} width="70%" />
        <SkeletonBlock height={14} width="40%" />
        <SkeletonBlock height={18} width={96} radius={8} />
      </View>
    </View>
  );
}

export function ProofRecordSkeleton() {
  return (
    <View style={styles.record} accessibilityLabel="Loading Proof record">
      <SkeletonBlock height={22} width="65%" />
      <SkeletonBlock height={14} width="45%" />
      <SkeletonBlock height={72} />
      <SkeletonBlock height={18} width="30%" />
      <SkeletonBlock height={120} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { overflow: "hidden" },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  copy: { flex: 1, gap: 8 },
  record: { gap: 14 },
});
