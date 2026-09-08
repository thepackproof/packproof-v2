function normalizedOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** One mounted scroll view restores once; native gestures own every later position. */
export function createScrollRestoration(initialOffsetY = 0) {
  const initial = normalizedOffset(initialOffsetY);
  let pending: number | null = initial > 0 ? initial : null;
  let awaitingOffset: number | null = null;
  let viewportHeight = 0;
  let contentHeight: number | null = null;

  return {
    setViewportHeight(height: number) {
      viewportHeight = normalizedOffset(height);
    },
    setContentHeight(height: number) {
      contentHeight = normalizedOffset(height);
    },
    restore(ready: boolean): number | null {
      if (!ready || pending === null || viewportHeight <= 0 || contentHeight === null) return null;
      const offset = Math.min(pending, Math.max(0, contentHeight - viewportHeight));
      pending = null;
      awaitingOffset = offset;
      return offset;
    },
    recordOffset(offset: number): number | null {
      if (pending !== null) return null;
      const next = normalizedOffset(offset);
      // Ignore queued pre-restoration events until native scrolling acknowledges
      // the requested position. Android can round the target to a physical pixel.
      if (awaitingOffset !== null && Math.abs(next - awaitingOffset) > 1) return null;
      awaitingOffset = null;
      return next;
    },
    cancelRestoration() {
      pending = null;
      awaitingOffset = null;
    },
  };
}
