import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, sizes, spacing, typography } from "../theme/tokens";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "success" | "destructive";

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  icon?: keyof typeof Ionicons.glyphMap;
  accessibilityHint?: string;
}) {
  const variant = props.variant ?? "primary";
  const disabled = Boolean(props.disabled || props.loading);
  return (
    <Pressable
      onPress={props.onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" ? styles.primary : null,
        variant === "secondary" ? styles.secondary : null,
        variant === "tertiary" ? styles.tertiary : null,
        variant === "success" ? styles.success : null,
        variant === "destructive" ? styles.destructive : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={variant === "secondary" || variant === "tertiary" ? colors.navy : colors.white} />
      ) : (
        <View style={styles.labelRow}>
          {props.icon ? (
            <Ionicons
              name={props.icon}
              size={18}
              color={variant === "secondary" || variant === "tertiary" ? colors.navy : colors.white}
            />
          ) : null}
          <Text
            style={[
              styles.label,
              variant === "secondary" || variant === "tertiary" ? styles.labelDark : null,
              variant === "destructive" ? styles.labelDestructive : null,
            ]}
          >
            {props.label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function IconButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={8}
      style={({ pressed }) => [styles.icon, pressed ? styles.pressed : null, props.disabled ? styles.disabled : null]}
    >
      <View>{props.children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: sizes.touch,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  primary: { backgroundColor: colors.navy },
  secondary: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.navy,
  },
  tertiary: { backgroundColor: "transparent" },
  success: { backgroundColor: colors.green },
  destructive: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.dangerMuted,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.85 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { ...typography.button, color: colors.white, textAlign: "center" },
  labelDark: { color: colors.navy },
  labelDestructive: { color: colors.danger },
  icon: {
    minWidth: sizes.touch,
    minHeight: sizes.touch,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
});
