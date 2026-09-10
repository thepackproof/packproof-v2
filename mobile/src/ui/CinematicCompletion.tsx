import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { haptic } from "../theme/haptics";
import { cinematicForScheme } from "../theme/cinematic";
import { motion, shouldUseLargeMotion } from "../theme/motion";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";

export function CinematicCompletion({ visible }: { visible: boolean }) {
  const { colors, scheme, reducedMotion } = useTheme();
  const accent = cinematicForScheme(scheme);
  const veil = useRef(new Animated.Value(0)).current;
  const mark = useRef(new Animated.Value(0.76)).current;
  const halo = useRef(new Animated.Value(0.68)).current;
  const haloOpacity = useRef(new Animated.Value(0)).current;
  const copy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      veil.setValue(0); mark.setValue(0.76); halo.setValue(0.68); haloOpacity.setValue(0); copy.setValue(0);
      return;
    }
    void haptic("success");
    if (!shouldUseLargeMotion(reducedMotion)) {
      veil.setValue(1); mark.setValue(1); copy.setValue(1);
      const timer = setTimeout(() => veil.setValue(0), 450);
      return () => clearTimeout(timer);
    }
    Animated.sequence([
      Animated.timing(veil, { toValue: 1, duration: motion.duration.instant, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.parallel([
        Animated.spring(mark, { toValue: 1, useNativeDriver: true, ...motion.spring.cinematic }),
        Animated.timing(copy, { toValue: 1, duration: motion.duration.reveal, delay: 90, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(haloOpacity, { toValue: 0.26, duration: 120, useNativeDriver: true }),
          Animated.parallel([
            Animated.timing(halo, { toValue: 1.55, duration: motion.duration.success, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(haloOpacity, { toValue: 0, duration: motion.duration.success, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          ]),
        ]),
      ]),
      Animated.delay(520),
      Animated.timing(veil, { toValue: 0, duration: motion.duration.normal, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [copy, halo, haloOpacity, mark, reducedMotion, veil, visible]);

  if (!visible) return null;
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay, { opacity: veil, backgroundColor: scheme === "dark" ? "rgba(24,32,43,0.92)" : "rgba(233,238,244,0.94)" }]}>
    <View style={styles.stage}>
      <Animated.View style={[styles.halo, { borderColor: accent.green, opacity: haloOpacity, transform: [{ scale: halo }] }]} />
      <Animated.View style={[styles.mark, { backgroundColor: accent.green, transform: [{ scale: mark }] }]}>
        <Ionicons name="shield-checkmark" size={48} color={colors.textOnPrimary} />
      </Animated.View>
      <Animated.View style={[styles.copy, { opacity: copy, transform: [{ translateY: copy.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Proof completed</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Recording committed · integrity verified</Text>
      </Animated.View>
    </View>
  </Animated.View>;
}

const styles = StyleSheet.create({
  overlay: { zIndex: 1000, alignItems: "center", justifyContent: "center" },
  stage: { alignItems: "center", justifyContent: "center", gap: 18 },
  halo: { position: "absolute", top: -22, width: 122, height: 122, borderRadius: 61, borderWidth: 3 },
  mark: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center", shadowColor: "#14805E", shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.18, shadowRadius: 24, elevation: 5 },
  copy: { alignItems: "center", gap: 4 },
  title: { ...typography.pageTitle, fontSize: 26, lineHeight: 32 },
  subtitle: { ...typography.secondary },
});
