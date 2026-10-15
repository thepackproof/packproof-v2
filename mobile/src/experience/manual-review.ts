/** Presentation consent is intentionally ephemeral. Native signing still binds
 * the actual original, metadata revision and declaration through the service. */
export function canConfirmManualReview(input: {
  acceptedBinding: string | null;
  currentBinding: string;
  blocked: boolean;
  busy: boolean;
}): boolean {
  return input.acceptedBinding === input.currentBinding && !input.blocked && !input.busy;
}

/** UI-only binding; never substitutes for the signed server challenge. */
export function manualReviewBinding(input: {
  proofId: string;
  originalId: string;
  accountId: string;
  apiBaseUrl: string;
  metadata: unknown;
  reviewRevision: string | number;
}): string {
  return JSON.stringify(input);
}
