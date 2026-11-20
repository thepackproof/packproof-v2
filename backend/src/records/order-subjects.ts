interface Ref { type: string; namespace: string; id: string }
interface ProjectedEvent {
  entity: Ref; references: Ref[]; kind: string; eventKey: string;
  associationScope: string; occurredAt: string | null; observedAt: string;
}
// Compute from the pinned revision so historical snapshots and newly written
// ones follow identical scope rules without republishing a business revision.
export function cartonStates(events: ProjectedEvent[]) {
  type Carton = {
    namespace: string; id: string; lastEventKind: string; lastEventKey: string;
    occurredAt: string | null; observedAt: string; deliveryStatus: 'delivered' | 'awaiting_evidence';
  };
  const cartons = new Map<string, Carton>();
  const ordered = [...events].sort((left, right) =>
    Date.parse(left.occurredAt ?? left.observedAt) - Date.parse(right.occurredAt ?? right.observedAt)
    || Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.eventKey.localeCompare(right.eventKey));
  for (const event of ordered) {
    if (event.associationScope !== 'order') continue;
    for (const ref of [event.entity, ...event.references]) {
      if (ref.type !== 'package') continue;
      const key = JSON.stringify([ref.namespace, ref.id]);
      const delivered = event.kind === 'delivery' || cartons.get(key)?.deliveryStatus === 'delivered';
      cartons.set(key, {namespace: ref.namespace, id: ref.id, lastEventKind: event.kind,
        lastEventKey: event.eventKey, occurredAt: event.occurredAt, observedAt: event.observedAt,
        deliveryStatus: delivered ? 'delivered' : 'awaiting_evidence'});
    }
  }
  return [...cartons.values()].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id));
}

export function presentOrderSnapshot(raw: unknown) {
  const view = raw as {events: ProjectedEvent[]; evidence: Array<{associationScope: string}>};
  const redactShared = <T extends {associationScope: string}>(item: T) =>
    item.associationScope !== 'shared' ? item : {...item, references: [], fields: {}, fieldLineage: {}, lines: []};
  return {...view, events: view.events.map(redactShared), evidence: view.evidence.map(redactShared),
    cartons: cartonStates(view.events)};
}
