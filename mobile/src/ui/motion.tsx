import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { motion, shouldUseLargeMotion } from "../theme/motion";
import { useTheme } from "../theme/ThemeProvider";

type PressableScaleProps = Omit<PressableProps, "style" | "children"> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  pressedStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
};

export function PressableScale(props: PressableScaleProps) {
  const { children, style, pressedStyle, scaleTo, onPressIn, onPressOut, ...rest } = props;
  const { reducedMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const target = scaleTo ?? motion.pressScale;

  function animateTo(value: number) {
    if (!shouldUseLargeMotion(reducedMotion)) {
      scale.setValue(1);
      return;
    }
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      ...motion.spring.press,
    }).start();
  }

  function handlePressIn(event: GestureResponderEvent) {
    animateTo(target);
    onPressIn?.(event);
  }

  function handlePressOut(event: GestureResponderEvent) {
    animateTo(1);
    onPressOut?.(event);
  }

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable {...rest} onPressIn={handlePressIn} onPressOut={handlePressOut} style={(state) => [style, state.pressed ? { opacity: 0.76 } : null, state.pressed ? pressedStyle : null]}>
        {children}
      </Pressable>
    </Animated.View>
  );
}

/** A subtle upward lift reserved for primary record cards and other navigation surfaces. */
export function LiftPressable(props: PressableScaleProps) {
  const { children, style, pressedStyle, onPressIn, onPressOut, ...rest } = props;
  const { reducedMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  function animate(active: boolean) {
    if (!shouldUseLargeMotion(reducedMotion)) {
      scale.setValue(1);
      translateY.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.spring(scale, { toValue: active ? motion.liftScale : 1, useNativeDriver: true, ...motion.spring.cinematic }),
      Animated.spring(translateY, { toValue: active ? -2 : 0, useNativeDriver: true, ...motion.spring.cinematic }),
    ]).start();
  }

  return (
    <Animated.View style={{ transform: [{ translateY }, { scale }] }}>
      <Pressable
        {...rest}
        onPressIn={(event) => { animate(true); onPressIn?.(event); }}
        onPressOut={(event) => { animate(false); onPressOut?.(event); }}
        style={(state) => [style, state.pressed ? pressedStyle : null]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function FadeSlideIn(props: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(shouldUseLargeMotion(reducedMotion) ? 0 : 1)).current;
  const translate = useRef(new Animated.Value(shouldUseLargeMotion(reducedMotion) ? motion.listOffset : 0)).current;

  useEffect(() => {
    if (!shouldUseLargeMotion(reducedMotion)) {
      opacity.setValue(1);
      translate.setValue(0);
      return;
    }
    const delay = Math.min(props.index ?? 0, 8) * motion.stagger;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: motion.duration.reveal,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translate, {
        toValue: 0,
        duration: motion.duration.reveal,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, props.index, reducedMotion, translate]);

  return (
    <Animated.View style={[props.style, { opacity, transform: [{ translateY: translate }] }]}>
      {props.children}
    </Animated.View>
  );
}

/** Screen-level continuity cue: a very small scale/slide settle rather than a hard route swap. */
export function RouteReveal(props: { routeKey: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!shouldUseLargeMotion(reducedMotion)) {
      opacity.setValue(1);
      translateY.setValue(0);
      scale.setValue(1);
      return;
    }
    opacity.setValue(0.72);
    translateY.setValue(8);
    scale.setValue(0.992);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: motion.duration.shared, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, ...motion.spring.cinematic }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, ...motion.spring.cinematic }),
    ]).start();
  }, [opacity, props.routeKey, reducedMotion, scale, translateY]);

  return <Animated.View style={[{ flex: 1 }, props.style, { opacity, transform: [{ translateY }, { scale }] }]}>{props.children}</Animated.View>;
}

export function PulseOpacity(props: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  active?: boolean;
}) {
  const { reducedMotion } = useTheme();
  const opacity = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    if (!props.active || !shouldUseLargeMotion(reducedMotion)) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: motion.duration.trackingPulse,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: motion.duration.trackingPulse,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, props.active, reducedMotion]);

  return <Animated.View style={[props.style, { opacity }]}>{props.children}</Animated.View>;
}

/** Slow, low-amplitude breathing cue for a current tracking point or active verification mark. */
export function PulseScale(props: { children: ReactNode; active?: boolean; style?: StyleProp<ViewStyle>; amount?: number }) {
  const { reducedMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!props.active || !shouldUseLargeMotion(reducedMotion)) {
      scale.setValue(1);
      return;
    }
    const amount = props.amount ?? 1.04;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: amount, duration: motion.duration.trackingPulse, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: motion.duration.trackingPulse, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [props.active, props.amount, reducedMotion, scale]);
  return <Animated.View style={[props.style, { transform: [{ scale }] }]}>{props.children}</Animated.View>;
}

/** One-shot verification halo. It intentionally does not loop. */
export function SuccessHalo(props: { children: ReactNode; active?: boolean; color: string; style?: StyleProp<ViewStyle> }) {
  const { reducedMotion } = useTheme();
  const scale = useRef(new Animated.Value(0.78)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!props.active || !shouldUseLargeMotion(reducedMotion)) {
      scale.setValue(1);
      opacity.setValue(0);
      return;
    }
    scale.setValue(0.78);
    opacity.setValue(0.26);
    Animated.parallel([
      Animated.timing(scale, { toValue: 1.42, duration: motion.duration.success, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: motion.duration.success, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [opacity, props.active, reducedMotion, scale]);
  return <Animated.View pointerEvents="none" style={[props.style, { borderColor: props.color, opacity, transform: [{ scale }] }]}>{props.children}</Animated.View>;
}
