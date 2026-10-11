import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from "react-native";
import { radii, sizes, spacing, typography } from "../theme/tokens";
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
  autoComplete?: TextInputProps["autoComplete"];
  textContentType?: TextInputProps["textContentType"];
  maxLength?: number;
}) {
  const { colors } = useTheme();
  const locked = props.editable === false;
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.textPrimary }]}>{props.label}</Text>
      <TextInput
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accent}
        secureTextEntry={props.secureTextEntry && !revealed}
        autoComplete={props.autoComplete}
        textContentType={props.textContentType}
        maxLength={props.maxLength}
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
            borderColor: focused ? colors.accentText : colors.controlBorder,
            backgroundColor: locked ? colors.disabledBackground : colors.inputBackground,
            color: locked ? colors.disabledText : colors.textPrimary,
          },
          props.multiline ? styles.multiline : null,
        ]}
      />
      {props.secureTextEntry ? <Pressable accessibilityRole="button" accessibilityLabel={`${revealed ? "Hide" : "Show"} ${props.label.toLowerCase()}`} accessibilityState={{ expanded: revealed }} onPress={() => setRevealed(value => !value)} style={{minHeight:48,justifyContent:"center",alignSelf:"flex-start",paddingHorizontal:8}}><Text style={{color:colors.accentText,fontSize:16}}>{revealed ? "Hide password" : "Show password"}</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...typography.secondaryStrong },
  input: {
    minHeight: sizes.touch,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...typography.body,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
});
