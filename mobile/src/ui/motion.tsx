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
      <Pressable {...rest} onPressIn={handlePressIn} onPressOut={handlePressOut} style={(state) => [style, state.pressed ? pressedStyle : null]}>
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
        duration: motion.duration.normal,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translate, {
        toValue: 0,
        duration: motion.duration.normal,
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
          duration: 1300,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.5,
          duration: 1300,
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
