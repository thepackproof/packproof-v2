import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, sizes, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { haptic, type HapticKind } from "../theme/haptics";
import { PressableScale } from "./motion";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "success" | "destructive";

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  icon?: keyof typeof Ionicons.glyphMap;
  accessibilityHint?: string;
  haptic?: HapticKind;
}) {
  const { colors } = useTheme();
  const variant = props.variant ?? "primary";
  const disabled = Boolean(props.disabled || props.loading);
  const hapticKind = props.haptic ?? (variant === "tertiary" || variant === "secondary" ? "none" : "light");
  const palette = buttonPalette(variant, colors);
  return (
    <PressableScale
      onPress={() => {
        void haptic(hapticKind);
        props.onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      style={[
        styles.base,
        {
          backgroundColor: palette.background,
          borderWidth: palette.borderWidth,
          borderColor: palette.border,
        },
        disabled ? { backgroundColor: colors.disabledBackground, borderColor: colors.border, opacity: 1 } : null,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={disabled ? colors.disabledText : palette.foreground} />
      ) : (
        <View style={styles.labelRow}>
          {props.icon ? <Ionicons name={props.icon} size={18} color={disabled ? colors.disabledText : palette.foreground} /> : null}
          <Text style={[styles.label, { color: disabled ? colors.disabledText : palette.foreground }]}>{props.label}</Text>
        </View>
      )}
    </PressableScale>
  );
}

export function IconButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <PressableScale
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={8}
      style={[styles.icon, props.disabled ? { opacity: 0.45 } : null]}
    >
      <View>{props.children}</View>
    </PressableScale>
  );
}

function buttonPalette(
  variant: ButtonVariant,
  colors: ReturnType<typeof useTheme>["colors"],
): { background: string; foreground: string; border: string; borderWidth: number } {
  switch (variant) {
    case "secondary":
      return { background: colors.surface, foreground: colors.textPrimary, border: colors.textPrimary, borderWidth: 1 };
    case "tertiary":
      return { background: "transparent", foreground: colors.textPrimary, border: "transparent", borderWidth: 0 };
    case "success":
      return { background: colors.success, foreground: colors.textOnPrimary, border: colors.success, borderWidth: 0 };
    case "destructive":
      return { background: colors.surface, foreground: colors.error, border: colors.errorMuted, borderWidth: 1 };
    default:
      return { background: colors.primary, foreground: colors.textOnPrimary, border: colors.primary, borderWidth: 0 };
  }
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
  labelRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { ...typography.button, textAlign: "center" },
  icon: {
    minWidth: sizes.touch,
    minHeight: sizes.touch,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
});
