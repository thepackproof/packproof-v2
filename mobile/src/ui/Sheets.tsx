import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";

export function BottomSheet(props: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
        <Pressable style={styles.backdrop} onPress={props.onClose} accessibilityLabel="Close" />
        <View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              backgroundColor: colors.surfaceElevated,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{props.children}</ScrollView>
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
    <BottomSheet visible={props.visible} title={props.title} onClose={props.onClose}>
      <Text style={[styles.message, { color: colors.textSecondary }]}>{props.message}</Text>
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
  message: { ...typography.body, marginBottom: spacing.lg },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  techRow: { gap: 4, paddingVertical: spacing.sm, borderBottomWidth: 1 },
  techLabel: { ...typography.caption },
  techValue: { ...typography.secondary },
  rawTitle: { ...typography.secondaryStrong, marginTop: spacing.md },
});
