import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion, shouldUseLargeMotion } from "../theme/motion";
import { Button } from "./Button";
import { Logo } from "./Logo";

export function SuccessState(props: {
  title: string;
  body: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { colors, reducedMotion } = useTheme();
  const check = useRef(new Animated.Value(shouldUseLargeMotion(reducedMotion) ? 0 : 1)).current;
  useEffect(() => {
    if (!shouldUseLargeMotion(reducedMotion)) {
      check.setValue(1);
      return;
    }
    Animated.sequence([
      Animated.timing(check, {
        toValue: 1.08,
        duration: motion.duration.success,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(check, {
        toValue: 1,
        useNativeDriver: true,
        ...motion.spring.settle,
      }),
    ]).start();
  }, [check, reducedMotion]);

  return (
    <View style={styles.wrap} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <Logo size={72} />
      <Animated.View style={{ transform: [{ scale: check }] }}>
        <Ionicons name="checkmark-circle" size={44} color={colors.success} accessibilityLabel="Finalized" />
      </Animated.View>
      <Text style={[styles.kicker, { color: colors.success }]}>PACKPROOF COMPLETE</Text>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{props.body}</Text>
      {props.detail ? <Text style={[styles.detail, { color: colors.textMuted }]}>{props.detail}</Text> : null}
      <View style={styles.actions}>
        <Button label={props.actionLabel} onPress={props.onAction} variant="success" haptic="none" />
        {props.onSecondary && props.secondaryLabel ? (
          <Button label={props.secondaryLabel} onPress={props.onSecondary} variant="tertiary" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xxl },
  kicker: { ...typography.caption, letterSpacing: 1.2 },
  title: { ...typography.pageTitle, textAlign: "center" },
  body: { ...typography.body, textAlign: "center" },
  detail: { ...typography.secondary },
  actions: { width: "100%", gap: spacing.sm, marginTop: spacing.lg },
});
