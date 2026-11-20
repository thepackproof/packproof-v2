interface Ref { type: string; namespace: string; id: string }
interface ProjectedEvent {
  entity: Ref; references: Ref[]; kind: string; eventKey: string;
  associationScope: string; occurredAt: string | null; observedAt: string;
  fields?: Record<string,unknown>; fieldLineage?: Record<string,unknown>;
}
const chronological = (left: ProjectedEvent,right: ProjectedEvent) =>
  Date.parse(left.occurredAt ?? left.observedAt) - Date.parse(right.occurredAt ?? right.observedAt)
  || Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.eventKey.localeCompare(right.eventKey);
// Compute from the pinned revision so historical snapshots and newly written
// ones follow identical scope rules without republishing a business revision.
export function cartonStates(events: ProjectedEvent[]) {
  type Carton = {
    namespace: string; id: string; lastEventKind: string; lastEventKey: string;
    occurredAt: string | null; observedAt: string; deliveryStatus: 'delivered' | 'awaiting_evidence';
  };
  const cartons = new Map<string, Carton>();
  const ordered = [...events].sort(chronological);
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
  const view = raw as {events: ProjectedEvent[]; evidence: Array<{associationScope: string}>;deliveryCoverage?:string};
  const redactShared = <T extends {associationScope: string}>(item: T) =>
    item.associationScope !== 'shared' ? item : {...item, references: [], fields: {}, fieldLineage: {}, lines: []};
  const aliases = new Set(view.events.filter(e=>e.kind==='order' && e.associationScope==='order' && e.fieldLineage?.sourceOrderName)
    .map(e=>e.fields?.sourceOrderName).filter((s):s is string=>typeof s==='string' && s.length>0 && s.length<=200));
  return {...view,events: view.events.map(redactShared).sort(chronological), evidence: view.evidence.map(redactShared),
    ...(aliases.size===1 ? {displayOrderReference:[...aliases][0]} : {}),deliveryCoverage:view.deliveryCoverage??'unreported',
    cartons: cartonStates(view.events)};
}
