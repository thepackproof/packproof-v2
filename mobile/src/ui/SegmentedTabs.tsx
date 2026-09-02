import { useEffect, useRef, useState } from "react";
import { Animated, LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { motion, shouldUseLargeMotion } from "../theme/motion";
import { haptic } from "../theme/haptics";

export function SegmentedTabs<T extends string>(props: {
  options: Array<{ id: T; label: string; icon: keyof typeof Ionicons.glyphMap }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  const { colors, reducedMotion } = useTheme();
  const [width, setWidth] = useState(0);
  const translate = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, props.options.findIndex((option) => option.id === props.selected));
  const segmentWidth = width > 0 ? width / props.options.length : 0;

  useEffect(() => {
    if (!segmentWidth) {
      return;
    }
    if (!shouldUseLargeMotion(reducedMotion)) {
      translate.setValue(index * segmentWidth);
      return;
    }
    Animated.spring(translate, {
      toValue: index * segmentWidth,
      useNativeDriver: true,
      ...motion.spring.pill,
    }).start();
  }, [index, reducedMotion, segmentWidth, translate]);

  function onLayout(event: LayoutChangeEvent) {
    setWidth(event.nativeEvent.layout.width);
  }

  return (
    <View
      style={[styles.track, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityRole="tablist"
      onLayout={onLayout}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pill,
            {
              width: segmentWidth,
              backgroundColor: colors.primary,
              transform: [{ translateX: translate }],
            },
          ]}
        />
      ) : null}
      {props.options.map((option) => {
        const selected = option.id === props.selected;
        return (
          <Pressable
            key={option.id}
            onPress={() => {
              if (!selected) {
                void haptic("selection");
                props.onSelect(option.id);
              }
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={styles.tab}
          >
            <Ionicons name={option.icon} size={16} color={selected ? colors.textOnPrimary : colors.textPrimary} />
            <Text style={[styles.label, { color: selected ? colors.textOnPrimary : colors.textPrimary }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    borderRadius: radii.pill,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
    minHeight: 44,
  },
  pill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: radii.pill,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    zIndex: 1,
  },
  label: { ...typography.secondaryStrong },
});
