import { sha256 } from '@noble/hashes/sha256';

export type SurfaceStage = 'before_opening' | 'during_unpacking' | 'after_opening' | 'unknown';
export type SurfaceSource = {
  fileName: string; sha256: string; byteSize: number; width: number; height: number;
  rotationDegrees: number; frameTimeMs: number; barcodeBounds: number[];
  [key: string]: unknown;
};
export type SurfaceBinding = {
  experimental: true; schemaVersion: 'surface-local/1'; captureSessionId: string;
  proofId: string; userId: string; apiBaseUrl: string; expectedTracking: string;
  operation: 'enrollment' | 'observation'; enrollmentId?: string;
  shipmentLegId: 'OUTBOUND' | 'RETURN'; contextStage: SurfaceStage;
  authorizationAt: string; qualification: 'UNQUALIFIED'; platform?: string; osVersion?: string;
};
export type SurfaceJournal = {
  binding: SurfaceBinding; sources: SurfaceSource[]; continuityEvents: Array<Record<string, unknown>>;
  finished: boolean; interrupted: boolean; root: string; profileId: string; unavailable: string[];
};
export interface SurfaceList {
  schemaVersion: string; experimental: boolean;
  capabilities: { collection: boolean; extraction: boolean; internalComparison: boolean; customerFindings: false; profileId: string; qualified: false };
  enrollments: Array<{ id: string; state?: string; shipmentLegId?: string; [key: string]: unknown }>;
  observations: Array<{ id: string; state?: string; [key: string]: unknown }>;
  comparisons: Array<{ id: string; state?: string; result?: unknown; [key: string]: unknown }>;
}
export const digest = (input: string | Uint8Array) => Array.from(sha256(input), b => b.toString(16).padStart(2, '0')).join('');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Verify exact native event bytes. Never 'repair' a torn or changed journal into a completed capture. */
export function parseSurfaceJournal(text: string): SurfaceJournal {
  if (text.length > 512*1024) throw new Error('The surface journal exceeds its budget. Originals are kept.');
  let previous: string | null = null, sequence = 0;
  let binding: SurfaceBinding | undefined;
  let finished = false, interrupted = false, profileId = 'unqualified';
  const sources = new Map<string, SurfaceSource>();
  const unavailable: string[] = [], continuityEvents: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (typeof row.eventJson !== 'string' || digest(row.eventJson) !== row.sha256) throw new Error('Surface journal integrity check failed. Originals are kept.');
    const event = JSON.parse(row.eventJson);
    if (event.sequence !== sequence++ || event.previous !== previous || finished) throw new Error('Surface journal continuity check failed. Originals are kept.');
    previous = row.sha256;
    if (event.type === 'STARTED') { if (binding) throw new Error('Repeated surface binding.'); binding = event.value.binding; profileId = event.value.profileId; }
    else if (event.type === 'SOURCE') {
      const source = event.value as SurfaceSource;
      if (!/^surface-original-\d{1,3}\.jpg$/.test(source.fileName) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !Number.isInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > 8*1024*1024 ||
        !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width <= 0 || source.height <= 0 ||
        source.width*source.height > 4_194_304 || !Number.isFinite(source.frameTimeMs) || source.frameTimeMs < 0 ||
        ![0,90,180,270].includes(source.rotationDegrees) || !Array.isArray(source.barcodeBounds) || source.barcodeBounds.length !== 4 ||
        !source.barcodeBounds.every(Number.isFinite) || sources.has(source.fileName)) throw new Error('Invalid selected surface source.');
      sources.set(source.fileName, source);
    } else if (event.type === 'SUPERSEDED') {
      if (!sources.delete(event.value.fileName)) throw new Error('Invalid candidate replacement.');
    } else if (event.type === 'CONTINUITY') continuityEvents.push(event.value);
    else if (event.type === 'UNAVAILABLE') unavailable.push(String(event.value.reason));
    else if (event.type === 'FINISHED') { finished = true; interrupted = event.value.interrupted === true; }
    else throw new Error('Unsupported surface journal event.');
  }
  if (!binding || binding.schemaVersion !== 'surface-local/1' || binding.experimental !== true || !/^cap_[A-Za-z0-9_-]{1,91}$/.test(binding.captureSessionId)) throw new Error('Surface journal binding is unavailable.');
  if (sources.size > 6 || [...sources.values()].reduce((total, source) => total+source.byteSize,0) > 8*1024*1024) throw new Error('Selected sources exceed the capture budget.');
  return { binding, sources: [...sources.values()], continuityEvents, finished, interrupted, root: previous!, profileId, unavailable };
}
/** Android decoder coordinates are rotated; preserved JPEG pixels are not. Map to exact source pixels. */
export function sourceBarcodePolygon(source: SurfaceSource): number[][] {
  const [l,t,r,b] = source.barcodeBounds;
  const points = [[l,t],[r,t],[r,b],[l,b]].map(([x,y]) => {
    switch (source.rotationDegrees) {
      case 90: return [y, source.height-x];
      case 180: return [source.width-x, source.height-y];
      case 270: return [source.width-y, x];
      default: return [x,y];
    }
  });
  if (points.some(([x,y]) => x < 0 || y < 0 || x > source.width || y > source.height)) throw new Error('Barcode bounds do not fit the preserved source.');
  // Native decoder boxes describe pixel edges; worker polygons use pixel centers.
  const xs = points.map(point => Math.min(source.width-1,point[0])), ys = points.map(point => Math.min(source.height-1,point[1]));
  return [[Math.min(...xs),Math.min(...ys)],[Math.max(...xs),Math.min(...ys)],[Math.max(...xs),Math.max(...ys)],[Math.min(...xs),Math.max(...ys)]];
}
export function surfaceCollectionAllowed(build: boolean, feature: boolean, optedIn: boolean, serverCollection: boolean, nativeAvailable: boolean) {
  return build && feature && optedIn && serverCollection && nativeAvailable;
}

/** Exact source-pixel convention shared by uploads and the real worker integration test. */
export function sourceRegions(sourceId:string,index:number,source:SurfaceSource): Array<{id:string;sourceId:string;group:'context'|'print';polygon:number[][];process:'unknown';trackId:string|null}> {
  return [
    {id:`context_${index}`,sourceId,group:'context',polygon:[[0,0],[source.width-1,0],[source.width-1,source.height-1],[0,source.height-1]],process:'unknown',trackId:null},
    {id:`print_${index}`,sourceId,group:'print',polygon:sourceBarcodePolygon(source),process:'unknown',trackId:'expected_barcode_only'},
  ];
}
