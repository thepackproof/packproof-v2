import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radii, spacing, typography, taskFirstTypography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Button, IconButton } from "./Button";
import { Ionicons } from "@expo/vector-icons";
import { ANDROID_TASK_FIRST_REBUILD } from "../experience/android-task-first";

export function BottomSheet(props: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  returnFocusRef?: RefObject<View | null>;
  dismissible?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors, reducedMotion } = useTheme();
  const { fontScale } = useWindowDimensions();
  const heading = useRef<Text>(null);
  const wasVisible = useRef(false);
  const dismissible = props.dismissible !== false;
  function close() { if (dismissible) props.onClose(); }
  useEffect(() => {
    const shouldRestore = wasVisible.current && !props.visible;
    wasVisible.current = props.visible;
    if (!ANDROID_TASK_FIRST_REBUILD || !shouldRestore || !props.returnFocusRef) return;
    const frame = requestAnimationFrame(() => {
      const target = findNodeHandle(props.returnFocusRef?.current ?? null);
      if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.visible, props.returnFocusRef]);
  return (
    <Modal visible={props.visible} transparent animationType={reducedMotion ? "none" : "slide"} onRequestClose={close}
      onShow={ANDROID_TASK_FIRST_REBUILD ? () => {
        const target = findNodeHandle(heading.current);
        if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
      } : undefined}
    >
      <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
        <Pressable style={styles.backdrop} onPress={close} disabled={!dismissible} accessible={!ANDROID_TASK_FIRST_REBUILD} accessibilityLabel="Close" />
        <View
          accessibilityViewIsModal={ANDROID_TASK_FIRST_REBUILD || undefined}
          onAccessibilityEscape={ANDROID_TASK_FIRST_REBUILD ? close : undefined}
          style={[
            styles.sheet,
            ANDROID_TASK_FIRST_REBUILD && { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: fontScale >= 1.6 ? "94%" : "86%" },
            {
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              backgroundColor: colors.surfaceElevated,
            },
          ]}
        >
          <View accessible={false} style={[styles.handle, { backgroundColor: colors.border }]} />
          {ANDROID_TASK_FIRST_REBUILD ? <View style={styles.headingRow}>
            <Text ref={heading} accessible accessibilityRole="header" style={[taskFirstTypography.sectionTitle, styles.headingText, { color: colors.textPrimary }]}>{props.title}</Text>
            <IconButton label={`Close ${props.title}`} onPress={close} disabled={!dismissible}><Ionicons name="close-outline" size={24} color={colors.textPrimary} /></IconButton>
          </View> : <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>}
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode={ANDROID_TASK_FIRST_REBUILD ? "on-drag" : undefined} contentContainerStyle={ANDROID_TASK_FIRST_REBUILD ? styles.scrollContent : undefined}>{props.children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function ConfirmationSheet(props: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={props.visible} title={props.title} onClose={props.onClose} dismissible={ANDROID_TASK_FIRST_REBUILD ? !props.busy : true}>
      <Text style={[styles.message, ANDROID_TASK_FIRST_REBUILD && taskFirstTypography.body, { color: colors.textSecondary }]}>{props.message}</Text>
      <View style={styles.actions}>
        <Button
          label={props.confirmLabel}
          onPress={props.onConfirm}
          loading={props.busy}
          variant={props.destructive ? "destructive" : "primary"}
          haptic={props.destructive ? "medium" : "medium"}
        />
        <Button label={props.cancelLabel ?? "Not now"} onPress={props.onClose} variant="tertiary" disabled={props.busy} />
      </View>
    </BottomSheet>
  );
}

export function TechnicalDetailsSheet(props: {
  visible: boolean;
  onClose: () => void;
  rows: Array<{ label: string; value: string }>;
  rawRows?: Array<{ label: string; value: string }>;
}) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={props.visible} title="Technical details" onClose={props.onClose}>
      <Text style={[styles.message, { color: colors.textSecondary }]}>
        These identifiers are for support and integrity inspection. They are not needed for ordinary use.
      </Text>
      {props.rows.map((row) => (
        <View key={row.label} style={[styles.techRow, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.techLabel, { color: colors.textSecondary }]}>{row.label}</Text>
          <Text selectable style={[styles.techValue, { color: colors.textPrimary }]}>
            {row.value || "—"}
          </Text>
        </View>
      ))}
      {props.rawRows && props.rawRows.length > 0 ? (
        <>
          <Text style={[styles.rawTitle, { color: colors.textPrimary }]}>Advanced / raw</Text>
          {props.rawRows.map((row) => (
            <View key={row.label} style={[styles.techRow, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.techLabel, { color: colors.textSecondary }]}>{row.label}</Text>
              <Text selectable style={[styles.techValue, { color: colors.textPrimary }]}>
                {row.value || "—"}
              </Text>
            </View>
          ))}
        </>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { flex: 1 },
  sheet: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: "82%",
    gap: spacing.md,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  title: { ...typography.sectionTitle },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headingText: { flex: 1, minWidth: 0 },
  scrollContent: { paddingBottom: 8 },
  message: { ...typography.body, marginBottom: spacing.lg },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  techRow: { gap: 4, paddingVertical: spacing.sm, borderBottomWidth: 1 },
  techLabel: { ...typography.caption },
  techValue: { ...typography.secondary },
  rawTitle: { ...typography.secondaryStrong, marginTop: spacing.md },
});
