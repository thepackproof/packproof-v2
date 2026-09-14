/** A relay can stop only the exact native session that deliberately enabled it. */
const stops = new Map<string, () => void>();
export function registerRemoteCaptureStop(sessionId: string, stop: () => void): () => void {
  if (stops.has(sessionId)) throw new Error('This camera session already has a controller.');
  stops.set(sessionId, stop);
  return () => { if (stops.get(sessionId) === stop) stops.delete(sessionId); };
}
export function stopRemoteCapture(sessionId: string): boolean {
  const stop = stops.get(sessionId);
  if (!stop) return false;
  stop();
  return true;
}
