/** Optional, versioned enrichment shared by every supported capture surface. */
export type IdentifierSurface = 'ANDROID' | 'IOS' | 'WEB' | 'WAREHOUSE';
export interface IdentifierPolicy {
  version: 1; captureEnabled: boolean; autofillEnabled: boolean; reviewEnabled: boolean;
  surface: IdentifierSurface;
}
export type IdentifierCoverage = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
export interface IdentifierObservation {
  schemaVersion: 1; clientEventId: string; captureSessionId: string; sequence: number;
  rawText: string; rawBytes: string | null; decoderEncoding: string | null;
  symbology: string; symbologyIdentifier: string | null;
  source: 'LIVE_CAMERA_ANALYSIS' | 'ENCODED_VIDEO_FRAME'; mediaTimeMs: number;
  timestampOrigin: 'MONOTONIC_APPROXIMATE' | 'ENCODED_MEDIA'; timestampUncertaintyMs: number | null;
  recordingRef: string; adapterVersion: string; decoderVersion: string; capabilityProfile: string;
  frameWidth: number | null; frameHeight: number | null; coordinateSpace: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  firstSeenMs: number; lastSeenMs: number; sightings: number;
}
export interface ParsedIdentifier {
  type: 'GTIN' | 'CONTAINED_GTIN' | 'SKU' | 'SSCC' | 'SERIAL' | 'LOT' | 'EXPIRY' | 'UNKNOWN';
  value: string; normalizedValue: string | null; namespace: string | null;
  validationResult: 'VALID' | 'INVALID' | 'UNVERIFIED' | 'UNSUPPORTED'; parserVersion: string;
}
export interface IdentifierClassification {
  kind: 'PRODUCT' | 'STRUCTURED' | 'OPAQUE' | 'UNSUPPORTED'; identifiers: ParsedIdentifier[];
  reasonCodes: string[]; classifierVersion: string;
}
export interface IdentifierResolution {
  observationId: string; clientEventId: string; sequence: number;
  route: 'SHIPPING' | 'PRODUCT' | 'AMBIGUOUS' | 'UNKNOWN';
  state: 'RESOLVED_PRODUCT' | 'MATCH' | 'CONFLICT' | 'UNKNOWN' | 'AMBIGUOUS' | 'STALE' | 'FORBIDDEN' | 'UNSUPPORTED';
  identifiers: ParsedIdentifier[]; reasonCodes: string[];
  product: { title: string; variant: string | null; sku: string | null; imageUrl: string | null;
    sourceRef: string; sourceRevision: string; sourceKind: 'ORDER_SNAPSHOT' | 'CATALOG' } | null;
  expected: Array<{ title: string; sku: string | null; gtin: string | null; sourceRef: string; sourceRevision: string }>;
  reviewRequired: boolean;
  decision: { decision: 'NOT_THIS_SHIPMENT' | 'ACKNOWLEDGE_MISMATCH'; reason: string; actorId: string; createdAt: string } | null;
  receivedAt: string; observation: IdentifierObservation; supplemental: boolean; evidenceId?: string | null;
}
export interface IdentifierReview {
  schemaVersion: 1; enabled: boolean; policy: IdentifierPolicy | null; revision: number;
  acceptedEventIds: string[]; acknowledgedSequence: number; coverage: IdentifierCoverage; omittedEvents: number;
  reviewRequired: boolean; observations: IdentifierResolution[];
  checkpoint: { id: string; revision: number; sha256: string; coverage: IdentifierCoverage } | null;
}
export interface IdentifierJournalState {
  schemaVersion: 1; apiScope: string; userId: string; proofId: string; sessionId: string; policy: IdentifierPolicy;
  events: IdentifierObservation[]; acknowledgedEventIds: string[]; omittedEvents: number;
  coverage: IdentifierCoverage; review: IdentifierReview | null; checkpointEventId: string | null;
}
export type DecodedIdentifier = Omit<IdentifierObservation,
  'schemaVersion' | 'clientEventId' | 'captureSessionId' | 'sequence' | 'firstSeenMs' | 'lastSeenMs' | 'sightings'>;
