import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion, policyDuration } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';

const shown = new Set<string>();
function markShown(key: string) {
  shown.add(key);
  if (shown.size > 128) { const oldest = shown.values().next().value; if (oldest) shown.delete(oldest); }
}
const ease = Easing.bezier(0.2, 0.75, 0.2, 1);
/** Presentation-only response. Children and all durable owners retain their identity. */
export function StateTransition({ eventKey, children, style }: { eventKey: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { motionMode } = useTheme(); const previous = useRef(eventKey);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const changed = previous.current !== eventKey; previous.current = eventKey; opacity.stopAnimation();
    if (motionMode === 'off' || !changed) { opacity.setValue(1); return; }
    opacity.setValue(0.86);
    const animation = Animated.timing(opacity, { toValue: 1, duration: policyDuration(motionMode, 220), easing: ease, useNativeDriver: true });
    animation.start(); return () => { animation.stop(); opacity.setValue(1); };
  }, [eventKey, motionMode, opacity]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}
type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode; style?: StyleProp<ViewStyle>; pressedStyle?: StyleProp<ViewStyle>; scaleTo?: number;
};
export function PressableScale(props: PressableScaleProps) {
  const { children, style, pressedStyle, scaleTo, onPressIn, onPressOut, ...rest } = props;
  const { motionMode } = useTheme(); const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => { scale.stopAnimation(); scale.setValue(1); return () => scale.stopAnimation(); }, [motionMode, rest.disabled, scale]);
  function animateTo(value: number) {
    scale.stopAnimation();
    if (motionMode !== 'full') { scale.setValue(1); return; }
    Animated.timing(scale, { toValue: value, duration: 100, easing: ease, useNativeDriver: true }).start();
  }
  return <Animated.View style={{ transform: [{ scale }] }}><Pressable {...rest}
    onPressIn={(event: GestureResponderEvent) => { animateTo(scaleTo ?? motion.pressScale); onPressIn?.(event); }}
    onPressOut={(event: GestureResponderEvent) => { animateTo(1); onPressOut?.(event); }}
    style={state => [style, state.pressed ? { opacity: 0.8 } : null, state.pressed ? pressedStyle : null]}>{children}</Pressable></Animated.View>;
}
export function LiftPressable(props: PressableScaleProps) { return <PressableScale {...props} scaleTo={props.scaleTo ?? motion.liftScale} />; }

/** A non-owning entrance. Status text and actions are visible and usable from the first frame. */
export function PresentationalReveal(props: { children: ReactNode; style?: StyleProp<ViewStyle>; onceKey?: string; eventKey?: string; duration?: number; index?: number; suppressed?: boolean }) {
  const { motionMode } = useTheme(); const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    opacity.stopAnimation(); translateY.stopAnimation();
    const repeated = Boolean(props.onceKey && shown.has(props.onceKey));
    if (props.onceKey) markShown(props.onceKey);
    if (props.suppressed || repeated || motionMode === 'off') { opacity.setValue(1); translateY.setValue(0); return; }
    opacity.setValue(0.86); translateY.setValue(motionMode === 'full' ? motion.listOffset : 0);
    const duration = policyDuration(motionMode, props.duration ?? motion.duration.reveal);
    const animation = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration, easing: ease, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration, easing: ease, useNativeDriver: true }),
    ]);
    animation.start(); return () => { animation.stop(); opacity.setValue(1); translateY.setValue(0); };
  }, [motionMode, props.onceKey, props.eventKey, props.duration, props.suppressed, opacity, translateY]);
  return <Animated.View style={[props.style, { opacity, transform: [{ translateY }] }]}>{props.children}</Animated.View>;
}
export function FadeSlideIn(props: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle>; onceKey?: string }) {
  return <PresentationalReveal {...props} />;
}
export function RouteReveal(props: { routeKey: string; children: ReactNode; style?: StyleProp<ViewStyle>; suppressed?: boolean }) {
  // Existing route identity is only a presentation trigger; this wrapper never owns the recorder.
  const cameraRoute = /capture|recording|camera|station/i.test(props.routeKey);
  return <PresentationalReveal eventKey={props.routeKey} suppressed={props.suppressed || cameraRoute} duration={240} style={[{ flex: 1 }, props.style]}>{props.children}</PresentationalReveal>;
}
/** Stable meaningful state markers replace persistent decorative loops. */
export function PulseOpacity(props: { children?: ReactNode; style?: StyleProp<ViewStyle>; active?: boolean }) {
  return <Animated.View style={props.style}>{props.children}</Animated.View>;
}
export function PulseScale(props: { children: ReactNode; active?: boolean; style?: StyleProp<ViewStyle>; amount?: number }) {
  return <Animated.View style={props.style}>{props.children}</Animated.View>;
}
/** Confirmed receipt flourish; callers provide actual confirmation and optional operation identity. */
export function SuccessHalo(props: { children: ReactNode; active?: boolean; color: string; style?: StyleProp<ViewStyle>; operationKey?: string }) {
  const { motionMode } = useTheme(); const played = useRef(false);
  const scale = useRef(new Animated.Value(1)).current, opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    opacity.stopAnimation(); scale.stopAnimation();
    const key = props.operationKey ? `receipt:${props.operationKey}` : undefined;
    if (!props.active || motionMode !== 'full' || played.current || (key && shown.has(key))) { opacity.setValue(0); scale.setValue(1); return; }
    played.current = true; if (key) markShown(key);
    scale.setValue(0.96); opacity.setValue(0.2);
    const animation = Animated.parallel([
      Animated.timing(scale, { toValue: 1.06, duration: motion.duration.success, easing: ease, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: motion.duration.success, easing: ease, useNativeDriver: true }),
    ]);
    animation.start(); return () => { animation.stop(); opacity.setValue(0); scale.setValue(1); };
  }, [props.active, props.operationKey, motionMode, opacity, scale]);
  return <Animated.View pointerEvents="none" style={[props.style, { borderColor: props.color, opacity, transform: [{ scale }] }]}>{props.children}</Animated.View>;
}
