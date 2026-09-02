import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radii, spacing, typography } from "../theme/tokens";
import { Button } from "./Button";

export function BottomSheet(props: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={props.onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>{props.title}</Text>
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
  return (
    <BottomSheet visible={props.visible} title={props.title} onClose={props.onClose}>
      <Text style={styles.message}>{props.message}</Text>
      <View style={styles.actions}>
        <Button
          label={props.confirmLabel}
          onPress={props.onConfirm}
          loading={props.busy}
          variant={props.destructive ? "destructive" : "primary"}
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
  return (
    <BottomSheet visible={props.visible} title="Technical details" onClose={props.onClose}>
      <Text style={styles.message}>These identifiers are for support and integrity inspection. They are not needed for ordinary use.</Text>
      {props.rows.map((row) => (
        <View key={row.label} style={styles.techRow}>
          <Text style={styles.techLabel}>{row.label}</Text>
          <Text selectable style={styles.techValue}>{row.value || "—"}</Text>
        </View>
      ))}
      {props.rawRows && props.rawRows.length > 0 ? (
        <>
          <Text style={styles.rawTitle}>Advanced / raw</Text>
          {props.rawRows.map((row) => (
            <View key={row.label} style={styles.techRow}>
              <Text style={styles.techLabel}>{row.label}</Text>
              <Text selectable style={styles.techValue}>{row.value || "—"}</Text>
            </View>
          ))}
        </>
      ) : null}
    </BottomSheet>
  );
}


const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  backdrop: { flex: 1 },
  sheet: {
    backgroundColor: colors.white,
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
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  title: { ...typography.sectionTitle, color: colors.navy },
  message: { ...typography.body, color: colors.slate, marginBottom: spacing.lg },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  techRow: { gap: 4, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  techLabel: { ...typography.caption, color: colors.slate },
  techValue: { ...typography.secondary, color: colors.navy },
  rawTitle: { ...typography.secondaryStrong, color: colors.navy, marginTop: spacing.md },
});
