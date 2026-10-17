/** A presentation-only gate. It never changes recorder, media or domain state. */
export function createCaptureFeedbackGate() {
  const active = new Set<symbol>();
  let revision = 0;
  return {
    silence() {
      const owner = Symbol('capture-feedback');
      active.add(owner);
      revision++;
      return () => { if (active.delete(owner)) revision++; };
    },
    permit() {
      const issuedAt = revision;
      return () => active.size === 0 && revision === issuedAt;
    },
  };
}

export const captureFeedbackGate = createCaptureFeedbackGate();

/** Check again after asynchronous system checks: a recording may have started,
 * or started and stopped, while a button's feedback was waiting to load. */
export async function emitCaptureSafeFeedback<T>(
  prepare: () => Promise<T | null>,
  emit: (value: T) => Promise<void>,
  gate = captureFeedbackGate,
): Promise<void> {
  const permitted = gate.permit();
  if (!permitted()) return;
  const value = await prepare();
  if (value !== null && permitted()) await emit(value);
}
