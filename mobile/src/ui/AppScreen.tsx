import { useEffect, useRef, type ReactNode } from "react";
import {
  RefreshControl,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { RestoringScrollView, type RestoringScrollViewHandle } from "./RestoringScrollView";

export function AppScreen(props: {
  children: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  padded?: boolean;
  background?: string;
  bottomInset?: boolean;
  extraBottom?: number;
  initialOffsetY?: number;
  restorationReady?: boolean;
  resetScrollKey?: string;
  onScrollOffset?: (offset: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<RestoringScrollViewHandle>(null);
  const previousResetKey = useRef(props.resetScrollKey);
  useEffect(() => { if (previousResetKey.current !== props.resetScrollKey) { previousResetKey.current = props.resetScrollKey; scroll.current?.scrollTo({y:0,animated:false}); } }, [props.resetScrollKey]);
  const { colors } = useTheme();
  const background = props.background ?? colors.background;
  // Insets belong to the viewport. Content padding scrolls away and lets controls
  // move beneath Android's status and navigation bars on edge-to-edge devices.
  const viewportStyle = {
    backgroundColor: background,
    paddingTop: insets.top,
    paddingBottom: props.bottomInset === false ? 0 : insets.bottom,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  };
  const paddingBottom = spacing.lg + (props.extraBottom ?? 0);
  const contentStyle = [
    styles.content,
    props.padded === false ? null : styles.padded,
    { paddingBottom, paddingTop: props.padded === false ? 0 : spacing.sm },
  ];

  if (props.scroll === false) {
    return (
      <View style={[styles.root, props.style, viewportStyle]}>
        <View style={[styles.root, contentStyle]}>{props.children}</View>
      </View>
    );
  }

  return (
    <View style={[styles.root, props.style, viewportStyle]}>
      <RestoringScrollView
        ref={scroll}
        style={styles.root}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        contentContainerStyle={contentStyle}
        initialOffsetY={props.initialOffsetY}
        restorationReady={props.restorationReady}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollOffset={props.onScrollOffset}
        refreshControl={
          props.onRefresh ? (
            <RefreshControl
              refreshing={Boolean(props.refreshing)}
              onRefresh={props.onRefresh}
              tintColor={colors.textPrimary}
              colors={[colors.accent]}
              progressBackgroundColor={colors.surface}
            />
          ) : undefined
        }
      >
        {props.children}
      </RestoringScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, gap: spacing.lg },
  padded: { paddingHorizontal: spacing.lg },
});
