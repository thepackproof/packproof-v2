/** Dependency-free API dashboard DTOs shared by server and browser clients.
 * This declaration module contains no runtime code or backend imports. */
export type ProofSearchState = 'AWAITING_CAPTURE' | 'IN_PROGRESS' | 'READY' | 'NEEDS_ATTENTION';
export type ProofSearchReadinessReason =
  | 'PRESERVATION_FAILED' | 'LEGACY_UNCONFIRMED' | 'FINALIZATION_INCOMPLETE'
  | 'PRESERVATION_PENDING' | 'CONFIRMATION_REQUIRED' | 'CAPTURE_REQUIRED';
export interface ProofSearchQuery {
  q?: string; state?: ProofSearchState; from?: string; through?: string;
  connectionId?: string; integrationAccountId?: string; limit?: number; after?: string;
}
export interface ProofSearchItem {
  proofId: string; transactionId: string; status: string;
  createdAt: string; updatedAt: string; finalizedAt: string | null;
  externalId: string | null; itemTitle: string | null; itemCount: number;
  trackingNumber: string | null; connectionId: string | null; provider: string | null;
  recordedBy: string | null;
  /** Server acceptance time of the earliest committed evidence, not camera time. */
  serverReceivedAt: string | null;
  readiness: { state: ProofSearchState; reason: ProofSearchReadinessReason | null; preserved: boolean };
}
export interface ProofSearchResult {
  apiVersion: 'v1'; schema: 'packproof.proof-search/v1'; proofs: ProofSearchItem[];
  nextCursor: string | null; hasMore: boolean; refreshedAt: string; cursorExpiresAt: string;
}
