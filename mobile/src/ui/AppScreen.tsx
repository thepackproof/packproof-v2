import type { ReactNode } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing } from "../theme/tokens";

export function AppScreen(props: {
  children: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  padded?: boolean;
  background?: string;
  bottomInset?: boolean;
  extraBottom?: number;
  contentOffsetY?: number;
  onScrollOffset?: (offset: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const background = props.background ?? colors.background;
  const paddingBottom = (props.bottomInset === false ? spacing.lg : Math.max(insets.bottom, spacing.lg)) + (props.extraBottom ?? 0);
  const contentStyle = [
    styles.content,
    props.padded === false ? null : styles.padded,
    { paddingBottom, paddingTop: props.padded === false ? 0 : Math.max(insets.top, spacing.sm) },
  ];

  if (props.scroll === false) {
    return <View style={[styles.root, { backgroundColor: background }, props.style, contentStyle]}>{props.children}</View>;
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    props.onScrollOffset?.(event.nativeEvent.contentOffset.y);
  }

  return (
    <View style={[styles.root, { backgroundColor: background }, props.style]}>
      <ScrollView
        contentContainerStyle={contentStyle}
        contentOffset={props.contentOffsetY ? { x: 0, y: props.contentOffsetY } : undefined}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        scrollEventThrottle={16}
        onScroll={props.onScrollOffset ? handleScroll : undefined}
        refreshControl={
          props.onRefresh ? (
            <RefreshControl refreshing={Boolean(props.refreshing)} onRefresh={props.onRefresh} tintColor={colors.navy} />
          ) : undefined
        }
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, gap: spacing.lg },
  padded: { paddingHorizontal: spacing.lg },
});
