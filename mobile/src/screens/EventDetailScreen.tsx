import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatDateTime } from "../copy/format";
import { chronologyCategoryLabel } from "../copy/chronology";
import { SOURCE_DISCLOSURE } from "../copy/errors";
import { colors, spacing, typography } from "../theme/tokens";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { InfoCard } from "../ui/ProofCard";
import { SourceBadge } from "../ui/SourceBadge";

export function EventDetailScreen() {
  const app = usePackProof();
  const event = app.selectedEvent;
  if (!event) {
    return (
      <AppScreen>
        <AppHeader title="Event" onBack={app.goBack} />
        <Text style={styles.meta}>Select an event from the Proof record.</Text>
      </AppScreen>
    );
  }
  return (
    <AppScreen extraBottom={24}>
      <AppHeader title={event.title} onBack={app.goBack} />
      <InfoCard>
        <Text style={styles.body}>{event.description || chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)}</Text>
        <Text style={styles.meta}>{formatDateTime(event.occurredAt)}</Text>
        <SourceBadge category={event.category} label={chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)} />
      </InfoCard>
      <InfoCard>
        <Row label="Source" value={event.source} />
        <Row label="Provider" value={event.provider ?? ""} />
        <Row label="Event identifier" value={event.id} />
        <Row label="Associated object" value={event.relatedEntityId ?? ""} />
        <Row label="Exact timestamp" value={event.occurredAt} />
      </InfoCard>
      <Text style={styles.note}>{SOURCE_DISCLOSURE}</Text>
    </AppScreen>
  );
}

function Row(props: { label: string; value: string }) {
  if (!props.value) {
    return null;
  }
  return (
    <View style={{ gap: 2 }}>
      <Text style={styles.label}>{props.label}</Text>
      <Text selectable style={styles.value}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.navy },
  meta: { ...typography.secondary, color: colors.slate },
  note: { ...typography.caption, color: colors.slate },
  label: { ...typography.caption, color: colors.slate },
  value: { ...typography.secondary, color: colors.navy },
});
