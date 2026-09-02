import { chronologyCategoryLabel } from "@packproof/copy/chronology";
import { SOURCE_DISCLOSURE } from "@packproof/copy/errors";
import { formatDateTime } from "@packproof/copy/format";
import type { ChronologyEntry } from "../api/types";
import { PageHeader } from "../components/PageHeader";

export function EventDetailScreen(props: {
  event: ChronologyEntry | null;
  onBack: () => void;
}) {
  if (!props.event) {
    return (
      <main className="page stack">
        <PageHeader title="Event" onBack={props.onBack} />
        <p className="meta">Select an event from the Proof record.</p>
      </main>
    );
  }
  const event = props.event;
  return (
    <main className="page stack">
      <PageHeader title={event.title} onBack={props.onBack} />
      <article className="info-card">
        <p>
          {event.description ||
            chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)}
        </p>
        <p className="meta">{formatDateTime(event.occurredAt)}</p>
        <p className="meta">
          {chronologyCategoryLabel(event.category, event.source, event.provider, event.eventType)}
        </p>
      </article>
      <article className="info-card">
        <Row label="Source" value={event.source} />
        <Row label="Provider" value={event.provider ?? ""} />
        <Row label="Event identifier" value={event.id} />
        <Row label="Associated object" value={event.relatedEntityId ?? ""} />
        <Row label="Exact timestamp" value={event.occurredAt} />
      </article>
      <p className="note">{SOURCE_DISCLOSURE}</p>
    </main>
  );
}

function Row(props: { label: string; value: string }) {
  if (!props.value) {
    return null;
  }
  return (
    <div>
      <div className="kicker">{props.label}</div>
      <p className="meta">{props.value}</p>
    </div>
  );
}
