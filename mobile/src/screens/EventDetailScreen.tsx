import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatDateTime } from "../copy/format";
import { chronologyCategoryLabel } from "../copy/chronology";
import { SOURCE_DISCLOSURE } from "../copy/errors";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { InfoCard } from "../ui/ProofCard";
import { SourceBadge } from "../ui/SourceBadge";

export function EventDetailScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const event = app.selectedEvent;
  if (!event) {
    return (
      <AppScreen>
        <AppHeader title="Event" onBack={app.goBack} />
        <Text style={[styles.meta, { color: colors.textSecondary }]}>Select an event from the Proof record.</Text>
      </AppScreen>
    );
  }
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title={event.title} onBack={app.goBack} />
      <InfoCard>
        <Text style={[styles.body, { color: colors.textPrimary }]}>
          {event.description || chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)}
        </Text>
        <Text style={[styles.meta, { color: colors.textSecondary }]}>{formatDateTime(event.occurredAt)}</Text>
        <SourceBadge
          category={event.category}
          label={chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)}
        />
      </InfoCard>
      <InfoCard>
        <Row label="Source" value={event.source} />
        <Row label="Provider" value={event.provider ?? ""} />
        <Row label="Event identifier" value={event.id} />
        <Row label="Associated object" value={event.relatedEntityId ?? ""} />
        <Row label="Exact timestamp" value={event.occurredAt} />
      </InfoCard>
      <Text style={[styles.note, { color: colors.textSecondary }]}>{SOURCE_DISCLOSURE}</Text>
    </AppScreen>
  );
}

function Row(props: { label: string; value: string }) {
  const { colors } = useTheme();
  if (!props.value) {
    return null;
  }
  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{props.label}</Text>
      <Text selectable style={[styles.value, { color: colors.textPrimary }]}>
        {props.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body },
  meta: { ...typography.secondary },
  note: { ...typography.caption },
  label: { ...typography.caption },
  value: { ...typography.secondary },
});
