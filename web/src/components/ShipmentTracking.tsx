import { StatusBadge } from "./StatusBadge";
import { useEffect, useState } from "react";
import { useViewState } from "../navigation-context";
import type { ShipmentEventView } from "../api/types";
import { trackingAvailabilityMessage, type TrackingAvailability } from "../presentation/proof-record";
import { Glyph } from "../site/Brand";
import { formatWhen } from "../format";

export type TrackingObservation = Pick<ShipmentEventView, "id" | "eventType" | "occurredAt" | "location" | "provider" | "source" | "eventData">;
type Coordinates = { latitude: number; longitude: number };

function coordinateNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function reportedCoordinates(data: Record<string, unknown>): Coordinates | null {
  // Only explicit coordinate pairs are accepted. A city name is never treated as a GPS fix.
  for (const candidate of [data, data.coordinates, data.location, data.tracking_location]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const point = candidate as Record<string, unknown>;
    const latitude = coordinateNumber(point.latitude ?? point.lat);
    const longitude = coordinateNumber(point.longitude ?? point.lng ?? point.lon);
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return { latitude, longitude };
  }
  return null;
}

export function mapUrls(point: Coordinates) {
  const { latitude, longitude } = point;
  const viewLatitude = Math.max(-85, Math.min(85, latitude));
  const bbox = [Math.max(-180, longitude - .06), Math.max(-85, viewLatitude - .035), Math.min(180, longitude + .06), Math.min(85, viewLatitude + .035)].join(",");
  return {
    embed: `https://www.openstreetmap.org/export/embed.html?${new URLSearchParams({ bbox, layer: "mapnik", marker: `${latitude},${longitude}` })}`,
    external: `https://www.openstreetmap.org/?${new URLSearchParams({ mlat: String(latitude), mlon: String(longitude) })}#map=12/${viewLatitude}/${longitude}`,
  };
}

function eventLabel(value: string) {
  return value.toLowerCase().replace(/_/g, " ").replace(/^\w/, letter => letter.toUpperCase());
}

export function ShipmentTracking({ events, carrier, trackingNumber, demo = false, refreshError, registration, sync }: {
  events: TrackingObservation[];
  carrier?: string | null;
  trackingNumber?: string | null;
  demo?: boolean;
  refreshError?: string | null;
  registration?: TrackingAvailability["registration"];
  sync?: TrackingAvailability["sync"];
}) {
  const [selectedId, setSelectedId] = useViewState<string | null>(`map.${window.location.pathname}.${trackingNumber||"unknown"}.selected`,null);
  const [expanded, setExpanded] = useViewState(`map.${window.location.pathname}.${trackingNumber||"unknown"}.expanded`,false);
  const [mapFailed,setMapFailed]=useState(false);
  const ordered = [...events].sort((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0));
  useEffect(()=>{if(!selectedId&&ordered[0])setSelectedId(ordered[0].id);},[selectedId,ordered[0]?.id]);
  const availability = trackingAvailabilityMessage(trackingNumber, { registration, sync, refreshError });
  const selected = ordered.find(event => event.id === selectedId) ?? ordered[0];
  const point = selected ? reportedCoordinates(selected.eventData) : null;
  // Web Mercator cannot display polar coordinates; retain the actual observation in text.
  const map = point && Math.abs(point.latitude) <= 85 ? mapUrls(point) : null;
  useEffect(()=>setMapFailed(false),[map?.embed]);
  const stale=selected&&!demo&&Date.now()-Date.parse(selected.occurredAt)>48*60*60*1000;
  const location = selected?.location || (point ? `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}` : "Location not reported");
  const locationSearch = selected?.location ? `https://www.openstreetmap.org/search?${new URLSearchParams({ query: selected.location })}` : null;
  if (!ordered.length) return <section className="shipment-tracking tracking-compact-empty" aria-label="Shipment tracking">
    <Glyph name="pin" size={23} /><div><h3>{carrier || "Shipment tracking"}</h3><p role="status">{availability || "Tracking number recorded. No carrier scan has been reported yet."}</p>{trackingNumber && <p className="tracking-number">{trackingNumber}</p>}</div>
  </section>;
  return <section className={`section shipment-tracking ${expanded ? "tracking-expanded" : ""}`} aria-label="Shipment tracking">
    <div className="panel-heading"><div><span className="panel-eyebrow"><Glyph name="pin" size={15} /> {demo ? "ILLUSTRATIVE SHIPMENT" : "CARRIER UPDATES"}</span><h2>Shipment tracking</h2></div><StatusBadge label={ordered[0] ? eventLabel(ordered[0].eventType) : "Awaiting updates"} /></div>
    {availability && <p role="status" className="map-unavailable">{availability}</p>}
    <p className="note">Latest carrier report: <time dateTime={ordered[0].occurredAt}>{formatWhen(ordered[0].occurredAt)}</time>.{sync?.lastSuccessfulSyncAt ? <> Last successful check: <time dateTime={sync.lastSuccessfulSyncAt}>{formatWhen(sync.lastSuccessfulSyncAt)}</time>.</> : null}</p>
    {events.some(event=>event.eventData.test===true)&&<p role="status" className="map-unavailable">Test tracking data · simulated shipment events, not real carrier evidence.</p>}
    {stale&&<p className="tracking-age">This selected report is more than 48 hours old. It is historical context, not a current location.</p>}
    <div className="tracking-layout"><div className="tracking-map-panel">
      <div className="tracking-map-heading"><span className="tracking-pin"><Glyph name="pin" size={21} /></span><div><span>{selected?.id === ordered[0]?.id ? "Last reported location" : "Selected observation"}</span><strong>{selected ? location : "Your journey will appear here"}</strong></div>{map && <button className="icon-button" aria-label={expanded ? "Reduce map" : "Expand map"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Glyph name="expand" size={18} /></button>}</div>
      {map ? <div className="map-frame"><iframe onError={()=>setMapFailed(true)} title={`Map of reported location: ${location}`} src={map.embed} loading="lazy" referrerPolicy="origin" sandbox="allow-scripts allow-same-origin allow-popups" /><p className="note">{mapFailed?"Map unavailable. Use the coordinates and reported scans below.":"If map tiles cannot load, the reported coordinates and scans remain available below."}</p><div className="map-caption">{demo ? "Example scan location" : "Reported scan location"} · {point!.latitude.toFixed(4)}, {point!.longitude.toFixed(4)}</div></div> : <div className="tracking-map-empty"><span><Glyph name="pin" size={35} /></span><h3>{selected ? "A location update, without a map pin." : "Ready for the next handoff."}</h3><p>{selected ? "This observation doesn’t include coordinates that can be displayed on the map." : "Recorded shipment updates will appear here when they become available."}</p>{locationSearch && <a className="btn btn-secondary" href={locationSearch} target="_blank" rel="noopener noreferrer">Find reported location on map <Glyph size={15} /></a>}</div>}
      <div className="tracking-map-footer"><span>{demo ? "Illustrative data · not a real shipment" : "Reported observations · not live GPS"}</span>{map && <a href={map.external} target="_blank" rel="noopener noreferrer">Open map ↗</a>}</div>
    </div><div className="tracking-details"><div className="tracking-identity"><span className="micro-label">SHIPMENT DETAILS</span><dl><div><dt>Carrier</dt><dd>{carrier || "Not provided"}</dd></div><div><dt>Tracking number</dt><dd className="tracking-number">{trackingNumber || "Not provided"}</dd></div><div><dt>Observation source</dt><dd>{selected ? [selected.provider, selected.source].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(" · ") || "Not provided" : "Awaiting update"}</dd></div></dl></div><div className="tracking-scans"><div><h3>Reported scans</h3>{selectedId!==ordered[0]?.id&&ordered[0]&&<button className="text-link" onClick={()=>setSelectedId(ordered[0].id)}>Show newest report</button>}<span>{ordered.length}</span></div>{ordered.length ? <ol>{ordered.map(event => <li key={event.id}><button aria-pressed={selected?.id === event.id} onClick={() => setSelectedId(event.id)}><span className="scan-dot" /><span><strong>{eventLabel(event.eventType)}</strong><span>{event.location || "Location not provided"}</span><time dateTime={event.occurredAt}>{formatWhen(event.occurredAt)}</time></span></button></li>)}</ol> : <p className="note">No shipment observations recorded yet.</p>}</div></div></div>
  </section>;
}
