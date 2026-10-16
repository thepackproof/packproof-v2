/** A push payload is a locator, never permission or a fallback list selection. */
export function notificationProofId(data: Record<string, unknown> | null | undefined, userId: string): string | null {
  return data?.userId === userId && typeof data.proofId === 'string' && /^proof_[A-Za-z0-9_-]+$/.test(data.proofId)
    ? data.proofId : null;
}
