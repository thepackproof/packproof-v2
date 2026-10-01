export type SurfaceKind = 'enrollment' | 'observation' | 'comparison';
export interface SurfaceRecord {
  id: string;
  proof_id: string;
  tenant_scope: string;
  actor_user_id: string;
  kind: SurfaceKind;
  package_instance_id: string;
  shipment_leg_id: string;
  enrollment_id: string | null;
  observation_id: string | null;
  canonical_json: string;
  sha256: string;
  created_at: string | Date;
  request_sha256: string;
}
export interface SurfaceSource {
  sourceId: string;
  submittedBy: string;
  sha256: string;
  objectKey: string;
  objectVersionId: string | null;
  contentType: string;
  byteSize: number;
  frameTimeMs: number | null;
  captureSessionId: string | null;
}
export interface SurfaceRegion {
  id: string;
  sourceId: string;
  group: 'print' | 'carton' | 'context';
  polygon: number[][];
  process: string;
  trackId: string | null;
}
export interface SurfaceCapture {
  schemaVersion: 'surface-command/1';
  captureSessionId: string | null;
  shipmentLegId: 'OUTBOUND' | 'RETURN';
  captureMode: 'live' | 'offline' | 'supplemental';
  contextStage: 'before_opening' | 'during_unpacking' | 'after_opening' | 'unknown';
  captureProfileId: string;
  deviceMetadata: Record<string, unknown>;
  continuityEvents: unknown[];
  sources: {
    sourceId: string;
    sha256: string;
    frameTimeMs: number | null;
  }[];
  regions: SurfaceRegion[];
  enrollmentId?: string;
}
