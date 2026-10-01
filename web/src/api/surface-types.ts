/** Experimental surface records. These are separate from the sealed Proof manifest. */
export type SurfaceScope = 'label' | 'carton' | 'assembly';
export type SurfaceStatus = 'requested' | 'processing' | 'inconclusive' | 'unsupported' | 'not_checked' | 'error' | 'consistent' | 'difference_observed';
export interface SurfaceSource {
  sourceId: string; sha256: string; contentType: string; byteSize: number; frameTimeMs: number | null;
  available?: boolean;
}
export interface SurfaceRegion {
  id?: string; regionId?: string; sourceId: string; group?: string; kind?: string;
  polygon?: Array<[number, number]>; [key: string]: unknown;
}
export interface SurfaceRecord {
  id: string; proofId: string; packageInstanceId: string; shipmentLegId: string; createdAt: string;
  sha256: string; sourceDigests: SurfaceSource[]; regionMap: SurfaceRegion[];
  captureProfileId: string; contextStage: string; captureMode: string; assurance: string;
  state: string; enrollmentId?: string; [key: string]: unknown;
}
export interface SurfaceComparison {
  id: string; enrollmentId: string; observationId: string; requestedScope: SurfaceScope;
  status: SurfaceStatus; createdAt: string;
  result: null | {
    qualification: string;
    scopeResults: Partial<Record<SurfaceScope, { status: SurfaceStatus; reasons: string[] }>>;
    coverage: unknown; limitations: string[]; method: unknown; sourceDigests: unknown;
    [key: string]: unknown;
  };
}
export interface SurfaceSummary {
  schemaVersion: 'surface-api/1'; experimental: true;
  capabilities: { collection: boolean; extraction: boolean; internalComparison: boolean; customerFindings: boolean; profileId: string; qualified: boolean };
  enrollments: SurfaceRecord[]; observations: SurfaceRecord[]; comparisons: SurfaceComparison[];
}
export interface SurfaceComparisonInput {
  enrollmentId: string; observationId: string; requestedScope: SurfaceScope; idempotencyKey: string;
}
export function surfaceCommand(input: SurfaceComparisonInput) {
  // Explicit allowlist: neither a UI nor an IPC caller can supply a physical score.
  return { schemaVersion: 'surface-command/1' as const, enrollmentId: input.enrollmentId, observationId: input.observationId, requestedScope: input.requestedScope };
}
export function surfaceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(surfaceCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${surfaceCanonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export interface SurfaceTransport {
  read(proofId: string): Promise<SurfaceSummary>;
  compare(proofId: string, input: SurfaceComparisonInput): Promise<SurfaceComparison>;
  export(proofId: string): Promise<void>;
  saveSource(proofId: string, source: SurfaceSource): Promise<void>;
  source(proofId: string, source: SurfaceSource): Promise<{ url: string; release?: () => void }>;
}
