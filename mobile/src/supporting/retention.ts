export type PreservationHold = { id: string; createdBy: string; reason: string; releasedAt: string | null };
export type RetentionState = { protectedUntil: string | null; blockers: string[]; holds: PreservationHold[]; deletionRequests: Array<{ id: string; state: string }> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const dateOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
export function readRetention(value: unknown): RetentionState {
  if (!object(value) || !dateOrNull(value.protectedUntil) || !Array.isArray(value.blockers) || !value.blockers.every(row => typeof row === 'string') || !Array.isArray(value.holds) || !Array.isArray(value.deletionRequests)) throw new Error('Preservation details could not be verified. Refresh to try again.');
  const holds = value.holds.map(row => {
    if (!object(row) || !identifier(row.id) || !identifier(row.createdBy) || typeof row.reason !== 'string' || !dateOrNull(row.releasedAt)) throw new Error('Preservation hold details could not be verified.');
    return { id: row.id, createdBy: row.createdBy, reason: row.reason, releasedAt: row.releasedAt };
  });
  const deletionRequests = value.deletionRequests.map(row => {
    if (!object(row) || !identifier(row.id) || typeof row.state !== 'string') throw new Error('Deletion review details could not be verified.');
    return { id: row.id, state: row.state };
  });
  return { protectedUntil: value.protectedUntil, blockers: value.blockers as string[], holds, deletionRequests };
}
export function preservationReason(value: string): string {
  const reason = value.trim();
  if (!reason || value.length > 1000) throw new Error('Enter a reason of up to 1,000 characters.');
  return reason;
}
export function releasableHold(state: RetentionState | null, holdId: string, userId: string): boolean {
  return !!state?.holds.some(hold => hold.id === holdId && hold.createdBy === userId && hold.releasedAt === null);
}
