import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { usePackProof } from "../app/PackProofProvider";
import { formatDateTime } from "../copy/format";
import { chronologyCategoryLabel, humanChronologyTitle } from "../copy/chronology";
import { SOURCE_DISCLOSURE } from "../copy/errors";
import { typography } from "../theme/tokens";
import { useTheme } from "../theme/ThemeProvider";
import { AppHeader } from "../ui/AppHeader";
import { AppScreen } from "../ui/AppScreen";
import { InfoCard } from "../ui/ProofCard";
import { SourceBadge } from "../ui/SourceBadge";
import { Button } from "../ui/Button";

export function EventDetailScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const event = app.selectedEvent;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const raw = app.proof?.events?.find(row => row.eventId === event?.id || row.eventId === event?.relatedEntityId);
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
      <AppHeader title={humanChronologyTitle(event.eventType, event.title)} onBack={app.goBack} />
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
      <Button label={detailsOpen ? "Hide exact event details" : "Exact event details"} variant="tertiary" onPress={() => setDetailsOpen(value => !value)} />
      {detailsOpen ? <InfoCard>
        <Row label="Source" value={event.source} />
        <Row label="Provider" value={event.provider ?? ""} />
        <Row label="Event identifier" value={event.id} />
        <Row label="Associated object" value={event.relatedEntityId ?? ""} />
        <Row label="Exact timestamp with time zone" value={event.occurredAt} />
        <Row label="Event type" value={event.eventType} />
        <Row label="Recorded actor" value={raw?.actorUserId ?? "Not identified"} />
        {raw ? <Row label="Original audit data" value={JSON.stringify(raw.data, null, 2)} /> : null}
      </InfoCard> : null}
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
