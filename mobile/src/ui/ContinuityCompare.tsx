import { Image, StyleSheet, Text, View } from "react-native";
import {
  comparisonPairs,
  comparisonSlotLabel,
  continuityResultLabel,
} from "../copy/custody";
import { spacing, typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { InfoCard } from "./ProofCard";
import type { ProofView } from "../v2-api";

export function ContinuityCompare(props: {
  proof: ProofView;
  contentUrl: (evidenceId: string) => string;
  token: string | null;
}) {
  const { colors } = useTheme();
  const latest = props.proof.continuityObservations?.[props.proof.continuityObservations.length - 1];
  const pairs = comparisonPairs({
    continuity: props.proof.continuityObservations,
    observations: props.proof.observations,
  });
  if (pairs.length === 0 && !latest) {
    return null;
  }
  const headers = props.token ? { Authorization: `Bearer ${props.token}` } : undefined;

  return (
    <>
      <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Before sending versus when received</Text>
      <InfoCard>
        {latest ? (
          <>
            <Text style={[styles.body, { color: colors.textPrimary }]}>{continuityResultLabel(latest.result)}</Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]}>{latest.summary}</Text>
          </>
        ) : (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            Compare these captures. PackProof records them; it does not judge what they depict.
          </Text>
        )}
        {pairs.map((pair) => (
          <View key={pair.slot} style={styles.slot}>
            <Text style={[styles.kicker, { color: colors.accent }]}>{comparisonSlotLabel(pair.slot)}</Text>
            <View style={styles.row}>
              <CaptureFrame
                heading="Before sending"
                uri={pair.originEvidenceId ? props.contentUrl(pair.originEvidenceId) : null}
                headers={headers}
              />
              <CaptureFrame
                heading="When received"
                uri={pair.receivedEvidenceId ? props.contentUrl(pair.receivedEvidenceId) : null}
                headers={headers}
              />
            </View>
          </View>
        ))}
      </InfoCard>
    </>
  );
}

function CaptureFrame(props: {
  heading: string;
  uri: string | null;
  headers?: Record<string, string>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.frame, { borderColor: colors.divider, backgroundColor: colors.background }]}>
      <Text style={[styles.meta, { color: colors.textSecondary }]}>{props.heading}</Text>
      {props.uri ? (
        <Image
          accessibilityLabel={props.heading}
          source={{ uri: props.uri, headers: props.headers }}
          style={styles.image}
          resizeMode="contain"
        />
      ) : (
        <Text style={[styles.missing, { color: colors.textSecondary }]}>
          No PackProof observation exists for this capture.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { ...typography.sectionTitle },
  body: { ...typography.bodyStrong },
  meta: { ...typography.caption },
  kicker: { ...typography.caption },
  slot: { gap: spacing.sm, marginTop: spacing.md },
  row: { flexDirection: "row", gap: spacing.sm },
  frame: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    padding: spacing.sm,
    gap: spacing.xs,
  },
  image: { width: "100%", height: 140, backgroundColor: "#111" },
  missing: { ...typography.caption, minHeight: 80, textAlign: "center" },
});
