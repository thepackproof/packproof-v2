import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";

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
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{props.label}</Text>
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
        style={[styles.input, props.multiline ? styles.multiline : null, props.editable === false ? styles.locked : null]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...typography.secondaryStrong, color: colors.navy },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.navy,
    ...typography.body,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  locked: { backgroundColor: colors.background, color: colors.slate },
});
