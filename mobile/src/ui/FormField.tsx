import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from "react-native";
import { radii, spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";

export function FormField(props: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
  editable?: boolean;
  accessibilityHint?: string;
}) {
  const { colors } = useTheme();
  const locked = props.editable === false;
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textPrimary }]}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        secureTextEntry={props.secureTextEntry}
        autoCapitalize={props.autoCapitalize ?? "none"}
        autoCorrect={false}
        keyboardType={props.keyboardType ?? "default"}
        multiline={props.multiline}
        editable={props.editable}
        accessibilityLabel={props.label}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={{ disabled: locked }}
        style={[
          styles.input,
          {
            borderColor: colors.border,
            backgroundColor: locked ? colors.disabledBackground : colors.inputBackground,
            color: locked ? colors.disabledText : colors.textPrimary,
          },
          props.multiline ? styles.multiline : null,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...typography.secondaryStrong },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...typography.body,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
});
