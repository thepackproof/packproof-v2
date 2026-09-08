import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { ScrollView, type ScrollViewProps } from "react-native";
import { createScrollRestoration } from "./scroll-restoration";

export type RestoringScrollViewProps = Omit<ScrollViewProps, "contentOffset"> & {
  initialOffsetY?: number;
  onScrollOffset?: (offset: number) => void;
  restorationReady?: boolean;
};

export type RestoringScrollViewHandle = Pick<ScrollView, "scrollTo" | "scrollToEnd">;

/** Saved offsets are mount-time input, never controlled native scroll positions. */
export const RestoringScrollView = forwardRef<RestoringScrollViewHandle, RestoringScrollViewProps>(
  function RestoringScrollView({
    initialOffsetY = 0,
    onScrollOffset,
    restorationReady = true,
    onScroll,
    onScrollBeginDrag,
    onLayout,
    onContentSizeChange,
    scrollEventThrottle = 32,
    ...props
  }, forwardedRef) {
    const scroll = useRef<ScrollView | null>(null);
    const restoration = useRef(createScrollRestoration(initialOffsetY)).current;
    const ready = useRef(restorationReady);
    ready.current = restorationReady;
    const frame = useRef<number | null>(null);

    useImperativeHandle(forwardedRef, () => ({
      scrollTo(...args) {
        restoration.cancelRestoration();
        scroll.current?.scrollTo(...args);
      },
      scrollToEnd(...args) {
        restoration.cancelRestoration();
        scroll.current?.scrollToEnd(...args);
      },
    }), [restoration]);

    const scheduleRestore = useCallback(() => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Coalesce native layout/content measurements before clamping the target.
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (!scroll.current) return;
        const offset = restoration.restore(ready.current);
        if (offset !== null) scroll.current.scrollTo({ y: offset, animated: false });
      });
    }, [restoration]);

    useEffect(() => {
      scheduleRestore();
      return () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
      };
    }, [restorationReady, scheduleRestore]);

    return <ScrollView
      {...props}
      ref={scroll}
      scrollEventThrottle={scrollEventThrottle}
      onLayout={event => {
        restoration.setViewportHeight(event.nativeEvent.layout.height);
        scheduleRestore();
        onLayout?.(event);
      }}
      onContentSizeChange={(width, height) => {
        restoration.setContentHeight(height);
        scheduleRestore();
        onContentSizeChange?.(width, height);
      }}
      onScroll={event => {
        const offset = restoration.recordOffset(event.nativeEvent.contentOffset.y);
        if (offset !== null) onScrollOffset?.(offset);
        onScroll?.(event);
      }}
      onScrollBeginDrag={event => {
        // A gesture wins over delayed data/layout restoration, even before the
        // first scroll event or the scheduled native scroll command has run.
        restoration.cancelRestoration();
        onScrollOffset?.(Math.max(0, event.nativeEvent.contentOffset.y));
        onScrollBeginDrag?.(event);
      }}
    />;
  },
);
