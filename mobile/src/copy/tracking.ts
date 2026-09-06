export interface ReportedCoordinates {
  latitude: number;
  longitude: number;
}

export const MAP_TILE_SIZE = 256;
export const MAP_MIN_ZOOM = 3;
export const MAP_MAX_ZOOM = 16;
export const MAP_DEFAULT_ZOOM = 12;
export const MAP_TILE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MERCATOR_MAX_LATITUDE = 85.05112878;

/** FileSystem modificationTime is expressed in seconds. Invalid or future times are not cache hits. */
export function isMapTileCacheFresh(modificationTime: number, now = Date.now()): boolean {
  const age = now - modificationTime * 1000;
  return Number.isFinite(age) && age >= 0 && age < MAP_TILE_CACHE_MAX_AGE_MS;
}

function coordinateNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/** Preserve explicit provider coordinates; never infer a point from a city name. */
export function reportedCoordinates(data: unknown): ReportedCoordinates | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const candidate of [record, record.coordinates, record.location, record.tracking_location]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    const latitude = coordinateNumber(value.latitude ?? value.lat);
    const longitude = coordinateNumber(value.longitude ?? value.lng ?? value.lon);
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

export function canMapCoordinates(point: ReportedCoordinates | null): boolean {
  return !!point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && Math.abs(point.latitude) <= MERCATOR_MAX_LATITUDE && Math.abs(point.longitude) <= 180;
}

export function boundedMapZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, Math.round(zoom))) : MAP_DEFAULT_ZOOM;
}

export interface MapTile {
  key: string;
  uri: string;
  left: number;
  top: number;
}

/** Only tiles intersecting the current viewport are requested. The scan pin stays centered. */
export function trackingMapTiles(point: ReportedCoordinates, zoom: number, width: number, height: number): MapTile[] {
  if (!canMapCoordinates(point) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const level = boundedMapZoom(zoom);
  const count = 2 ** level;
  // At 180 degrees, wrap to the first tile instead of requesting x === count.
  const longitude = ((point.longitude + 180) % 360 + 360) % 360 - 180;
  const sin = Math.sin(point.latitude * Math.PI / 180);
  const centerX = (longitude + 180) / 360 * count * MAP_TILE_SIZE;
  const centerY = Math.max(0, Math.min(count * MAP_TILE_SIZE,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * count * MAP_TILE_SIZE));
  // Native dimensions are bounded to prevent a malformed measurement creating a huge request list.
  const viewportWidth = Math.min(width, 2048);
  const viewportHeight = Math.min(height, 2048);
  const originX = centerX - viewportWidth / 2;
  const originY = centerY - viewportHeight / 2;
  const result: MapTile[] = [];
  for (let y = Math.max(0, Math.floor(originY / MAP_TILE_SIZE)); y < Math.min(count, Math.ceil((originY + viewportHeight) / MAP_TILE_SIZE)); y++) {
    for (let x = Math.floor(originX / MAP_TILE_SIZE); x < Math.ceil((originX + viewportWidth) / MAP_TILE_SIZE); x++) {
      const wrappedX = ((x % count) + count) % count;
      result.push({
        key: `${level}/${x}/${y}`,
        uri: `https://tile.openstreetmap.org/${level}/${wrappedX}/${y}.png`,
        left: x * MAP_TILE_SIZE - originX,
        top: y * MAP_TILE_SIZE - originY,
      });
    }
  }
  return result;
}

export function trackingMapUrl(point: ReportedCoordinates, zoom = MAP_DEFAULT_ZOOM): string {
  return `https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=${boundedMapZoom(zoom)}/${point.latitude}/${point.longitude}`;
}

export function trackingLocationSearchUrl(location: string | null | undefined): string | null {
  const value = location?.trim();
  return value ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(value)}` : null;
}

export function shipmentEventLabel(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function isHistoricalReport(occurredAt: string, now = Date.now()): boolean {
  const time = Date.parse(occurredAt);
  return Number.isFinite(time) && now - time > 48 * 60 * 60 * 1000;
}
