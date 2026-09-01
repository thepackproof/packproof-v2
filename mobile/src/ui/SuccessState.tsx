import { StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../theme/tokens";
import { Button } from "./Button";
import { Logo } from "./Logo";

export function SuccessState(props: {
  title: string;
  body: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="summary">
      <Logo size={72} />
      <Text style={styles.kicker}>PACKPROOF COMPLETE</Text>
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.body}>{props.body}</Text>
      {props.detail ? <Text style={styles.detail}>{props.detail}</Text> : null}
      <View style={styles.actions}>
        <Button label={props.actionLabel} onPress={props.onAction} variant="success" />
        {props.onSecondary && props.secondaryLabel ? (
          <Button label={props.secondaryLabel} onPress={props.onSecondary} variant="tertiary" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xxl },
  kicker: { ...typography.caption, color: colors.green, letterSpacing: 1.2 },
  title: { ...typography.pageTitle, color: colors.navy, textAlign: "center" },
  body: { ...typography.body, color: colors.slate, textAlign: "center" },
  detail: { ...typography.secondary, color: colors.textMuted },
  actions: { width: "100%", gap: spacing.sm, marginTop: spacing.lg },
});
