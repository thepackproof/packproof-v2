import { useEffect, useRef, type ComponentProps } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion } from "../theme/motion";
import { statusTone, type StatusTone } from "../copy/status-tone";
export { statusTone } from "../copy/status-tone";
import type { IntegrityState } from "../copy/status";

type StatusIcon = ComponentProps<typeof Ionicons>["name"];

/** Only a newly confirmed finalization reveals the shield; browsing old records is quiet. */
export function FinalizationMark(props: {
  finalized: boolean;
  size?: number;
  color?: string;
  fallbackIcon?: StatusIcon;
  animateOnMount?: boolean;
}) {
  const { colors, reducedMotion } = useTheme();
  const reveal = useRef(new Animated.Value(1)).current;
  const previous = useRef(props.animateOnMount ? false : props.finalized);
  const size = props.size ?? 18;
  useEffect(() => {
    const newlyFinalized = props.finalized && !previous.current;
    previous.current = props.finalized;
    if (reducedMotion || !newlyFinalized) {
      reveal.setValue(1);
      return;
    }
    reveal.setValue(0);
    const animation = Animated.timing(reveal, {
      toValue: 1, duration: motion.duration.success,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [props.finalized, reducedMotion, reveal]);
  const color = props.color ?? colors.success;
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {props.finalized ? <Animated.View pointerEvents="none" style={[
      styles.halo, { borderColor: color, opacity: reveal.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.3, 0.18, 0] }),
        transform: [{ scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.65] }) }] },
    ]} /> : null}
    <Animated.View style={{ opacity: props.finalized ? reveal.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) : 1,
      transform: [{ scale: props.finalized ? reveal.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) : 1 }] }}>
      <Ionicons name={props.finalized ? "shield-checkmark-outline" : props.fallbackIcon ?? "shield-outline"} size={size} color={color} />
    </Animated.View>
  </View>;
}

export function StatusBadge(props: {
  label: string;
  tone?: StatusTone;
  semantic?: "integrity" | "shipment";
  finalized?: boolean;
}) {
  const { colors, reducedMotion } = useTheme();
  const tone = props.tone ?? statusTone(props.label);
  const previousLabel = useRef(props.label);
  const change = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const changed = previousLabel.current !== props.label;
    previousLabel.current = props.label;
    if (!changed || reducedMotion) { change.setValue(1); return; }
    // Text changes immediately; the card and badge keep their component identity.
    change.setValue(0);
    const animation = Animated.timing(change, {
      toValue: 1, duration: motion.duration.normal, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [props.label, reducedMotion, change]);
  const palette =
    tone === "error"
      ? { background: colors.errorSoft, border: colors.errorMuted, text: colors.error }
      : tone === "warning"
        ? { background: colors.warningSoft, border: colors.warningSoftBorder, text: colors.warningText }
        : props.semantic === "integrity"
          ? { background: colors.integritySoft, border: colors.integritySoft, text: colors.integrityText }
          : props.semantic === "shipment"
            ? { background: colors.shipmentSoft, border: colors.shipmentSoft, text: colors.shipmentText }
            : tone === "info"
              ? { background: colors.accentSoft, border: colors.accentSoftBorder, text: colors.accentText }
              : tone === "success"
                ? { background: colors.successSoft, border: colors.successSoftBorder, text: colors.successText }
                : { background: colors.surfaceElevated, border: colors.border, text: colors.textSecondary };
  const icon: StatusIcon = tone === "error" ? "alert-circle-outline"
    : tone === "warning" ? "alert-outline"
      : /uploading/i.test(props.label) ? "arrow-up-circle-outline"
        : props.semantic === "integrity" ? "finger-print-outline"
          : props.semantic === "shipment" ? "cube-outline"
            : /finalizing|finishing|saving proof/i.test(props.label) ? "shield-outline"
              : tone === "success" ? "checkmark-circle-outline"
                : tone === "info" ? "information-circle-outline" : "time-outline";
  return (
    <Animated.View accessibilityLiveRegion="polite" style={[styles.badge,
      { backgroundColor: palette.background, borderColor: palette.border,
        opacity: change.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
        transform: [{ translateY: change.interpolate({ inputRange: [0, 1], outputRange: [2, 0] }) }] },
    ]}>
      <FinalizationMark finalized={props.finalized === true} size={16} color={palette.text} fallbackIcon={icon} />
      <Text style={[styles.label, { color: palette.text }]}>{props.label}</Text>
    </Animated.View>
  );
}

export function IntegrityMark(props: { state: IntegrityState; label?: string }) {
  const { colors } = useTheme();
  if (props.state === "none") return null;
  return (
    <View style={styles.integrity} accessibilityLabel={props.label ?? (props.state === "finalized" ? "Sealed record" : "Evidence secured")}>
      <FinalizationMark finalized={props.state === "finalized"} size={18} color={props.state === "finalized" ? colors.success : colors.integrityText} fallbackIcon="checkmark-circle-outline" />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%",
    borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 6, borderWidth: 1,
  },
  label: { ...typography.caption, flexShrink: 1 },
  integrity: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  halo: { ...StyleSheet.absoluteFillObject, borderWidth: 1, borderRadius: 999 },
});
