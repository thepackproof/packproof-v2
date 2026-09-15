import { StyleSheet, Text, View } from "react-native";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";
import { Logo } from "./Logo";
import { FinalizationMark } from "./StatusBadge";

export function SuccessState(props: {
  title: string;
  body: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface }]} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <Logo size={72} />
      <View style={[styles.seal, { backgroundColor: colors.successSoft }]} accessibilityLabel="Finalized">
        <FinalizationMark finalized size={44} color={colors.successText} animateOnMount />
      </View>
      <Text style={[styles.kicker, { color: colors.successText }]}>PACKPROOF COMPLETE</Text>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{props.title}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{props.body}</Text>
      {props.detail ? <Text style={[styles.detail, { color: colors.textMuted }]}>{props.detail}</Text> : null}
      <View style={styles.actions}>
        <Button label={props.actionLabel} onPress={props.onAction} variant="success" haptic="none" />
        {props.onSecondary && props.secondaryLabel ? (
          <Button label={props.secondaryLabel} onPress={props.onSecondary} variant="tertiary" />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xxl },
  kicker: { ...typography.caption, letterSpacing: 1.2 },
  title: { ...typography.pageTitle, textAlign: "center" },
  body: { ...typography.body, textAlign: "center" },
  detail: { ...typography.finePrint, textAlign: "center" },
  seal: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  actions: { width: "100%", gap: spacing.sm, marginTop: spacing.lg },
});
