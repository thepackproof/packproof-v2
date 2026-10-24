/** Presentation only: compare actual instants, retain unknown source dates, never choose another selected event. */
export function sourceEventInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}
export function orderSourceEvents<T extends { id: string; occurredAt?: string | null }>(events: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const event of events) if (!unique.has(event.id)) unique.set(event.id, event);
  return [...unique.values()].sort((a, b) => {
    const aTime = sourceEventInstant(a.occurredAt), bTime = sourceEventInstant(b.occurredAt);
    if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
    if (aTime === null && bTime !== null) return 1;
    if (aTime !== null && bTime === null) return -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
export function selectedSourceEvent<T extends { id: string }>(events: readonly T[], selectedId: string | null): T | null {
  return selectedId === null ? null : events.find(event => event.id === selectedId) ?? null;
}
