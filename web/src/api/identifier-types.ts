import type { IdentifierResolution } from '../../../backend/src/identifiers/types';

/** Shared API projection; independent of React and any client presentation layer. */
export interface IdentifierProjection {
  schemaVersion: 1;
  coverage: string;
  reviewRequired: boolean;
  observations: IdentifierResolution[];
}
