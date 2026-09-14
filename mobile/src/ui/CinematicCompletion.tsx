import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../theme/haptics";
import { motion } from "../theme/motion";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { FinalizationMark } from "./StatusBadge";

/** A confirmed upload can celebrate without hiding the next order or capturing input. */
export function CinematicCompletion({ visible }: { visible: boolean }) {
  const { colors, reducedMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const shown = useRef(false);
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) { shown.current = false; reveal.setValue(0); return; }
    // Theme and accessibility updates must never replay completion feedback.
    if (!shown.current) { shown.current = true; void haptic("success"); }
    if (reducedMotion) { reveal.setValue(1); return; }
    const animation = Animated.timing(reveal, {
      toValue: 1, duration: motion.duration.normal, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reducedMotion, reveal, visible]);
  if (!visible) return null;
  return <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" style={[
    styles.notice, { top: insets.top + spacing.sm, opacity: reveal, backgroundColor: colors.surface, borderColor: colors.successSoftBorder,
      transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] },
  ]}>
    <View style={[styles.mark, { backgroundColor: colors.successSoft }]}>
      <FinalizationMark finalized size={26} color={colors.successText} animateOnMount />
    </View>
    <View style={styles.copy}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Proof completed</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Your recording is saved and the record is sealed.</Text>
    </View>
  </Animated.View>;
}

const styles = StyleSheet.create({
  notice: { position: "absolute", left: spacing.lg, right: spacing.lg, zIndex: 1000, borderWidth: 1, borderRadius: radii.lg,
    flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, elevation: 5,
    shadowColor: "#23262D", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12 },
  mark: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  title: { ...typography.cardTitle },
  subtitle: { ...typography.finePrint },
});
