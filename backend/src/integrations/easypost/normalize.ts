import { sha256Hex } from "../../hash.js";
import type { TrustedTrackingObservation, TrustedTrackingSnapshot } from "../trusted-shipment-adapter.js";
import type { EasyPostTracker, EasyPostTrackingDetail, EasyPostTrackingLocation } from "./types.js";

export const EASYPOST_PROVIDER = "easypost";

const STATUS_MAP: Record<string, string> = {
  pre_transit: "LABEL_CREATED",
  in_transit: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  return_to_sender: "RETURN_TO_SENDER",
  failure: "DELIVERY_EXCEPTION",
};

const DETAIL_MAP: Record<string, string> = {
  label_created: "LABEL_CREATED",
  arrived_at_facility: "ARRIVED_AT_FACILITY",
  arrived_at_destination: "ARRIVED_AT_FACILITY",
  arrived_at_pickup_location: "ARRIVED_AT_FACILITY",
  received_at_destination_facility: "ARRIVED_AT_FACILITY",
  received_at_origin_facility: "ARRIVED_AT_FACILITY",
  departed_facility: "DEPARTED_FACILITY",
  departed_origin_facility: "DEPARTED_FACILITY",
  delivery_exception: "DELIVERY_EXCEPTION",
  transit_exception: "DELIVERY_EXCEPTION",
  delayed: "DELIVERY_EXCEPTION",
  damaged: "DELIVERY_EXCEPTION",
  lost: "DELIVERY_EXCEPTION",
  weather_delay: "DELIVERY_EXCEPTION",
  return: "RETURN_TO_SENDER",
  out_for_delivery: "OUT_FOR_DELIVERY",
  in_transit: "IN_TRANSIT",
};

export function mapEasyPostStatus(status: string | null | undefined, statusDetail?: string | null): string {
  const detail = (statusDetail ?? "").trim().toLowerCase();
  if (detail && DETAIL_MAP[detail]) {
    return DETAIL_MAP[detail];
  }
  const key = (status ?? "").trim().toLowerCase();
  return STATUS_MAP[key] ?? "CARRIER_EVENT";
}

export function formatEasyPostLocation(location: EasyPostTrackingLocation | null | undefined): string | null {
  if (!location) {
    return null;
  }
  const parts = [location.city, location.state, location.zip, location.country]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function trackingDetailSourceEventId(trackerId: string, detail: EasyPostTrackingDetail): string {
  const location = detail.tracking_location;
  const canonical = [
    detail.datetime ?? "",
    detail.status ?? "",
    detail.status_detail ?? "",
    detail.message ?? "",
    location?.city ?? "",
    location?.state ?? "",
    location?.zip ?? "",
    location?.country ?? "",
  ].join("|");
  return `easypost:${trackerId}:td:${sha256Hex(canonical).slice(0, 32)}`;
}

export function normalizeEasyPostTracker(
  tracker: EasyPostTracker,
  fallbackCarrier?: string | null,
): TrustedTrackingSnapshot {
  const trackerId = typeof tracker.id === "string" && tracker.id.trim() ? tracker.id.trim() : "trk_unknown";
  const carrier =
    (typeof tracker.carrier === "string" && tracker.carrier.trim() ? tracker.carrier.trim() : null) ??
    (fallbackCarrier?.trim() || null);
  const details = Array.isArray(tracker.tracking_details) ? tracker.tracking_details : [];
  const observations: TrustedTrackingObservation[] = [];
  const seen = new Set<string>();

  for (const detail of details) {
    const occurredAt = parseOccurredAt(detail.datetime);
    if (!occurredAt) {
      continue;
    }
    const sourceEventId = trackingDetailSourceEventId(trackerId, detail);
    if (seen.has(sourceEventId)) {
      continue;
    }
    seen.add(sourceEventId);
    const status = typeof detail.status === "string" ? detail.status : tracker.status;
    observations.push({
      sourceEventId,
      carrierStatus: status ?? null,
      eventType: mapEasyPostStatus(status, detail.status_detail),
      occurredAt,
      location: formatEasyPostLocation(detail.tracking_location),
      eventData: trackingDetailEventData(tracker, detail),
    });
  }

  if (observations.length === 0) {
    const occurredAt =
      parseOccurredAt(tracker.updated_at) ?? parseOccurredAt(tracker.created_at) ?? new Date().toISOString();
    observations.push({
      sourceEventId: `easypost:${trackerId}:status:${tracker.status ?? "unknown"}`,
      carrierStatus: tracker.status ?? null,
      eventType: mapEasyPostStatus(tracker.status, tracker.status_detail),
      occurredAt,
      location: null,
      eventData: trackerStatusEventData(tracker),
    });
  }

  const weightObservation = weightObservationFromTracker(tracker, trackerId);
  if (weightObservation) {
    observations.push(weightObservation);
  }

  return {
    provider: EASYPOST_PROVIDER,
    carrier,
    observations,
    providerCursor: trackerId.startsWith("trk_") ? trackerId : null,
    mode: typeof tracker.mode === "string" ? tracker.mode : null,
  };
}

function weightObservationFromTracker(
  tracker: EasyPostTracker,
  trackerId: string,
): TrustedTrackingObservation | null {
  const raw = tracker.weight;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const occurredAt =
    parseOccurredAt(tracker.updated_at) ?? parseOccurredAt(tracker.created_at) ?? new Date().toISOString();
  return {
    sourceEventId: `easypost:${trackerId}:weight:${value}`,
    eventType: "WEIGHT_RECORDED",
    occurredAt,
    location: null,
    eventData: {
      value,
      unit: "oz",
      reportedBy: "carrier",
      via: "easypost",
    },
  };
}

function trackingDetailEventData(
  tracker: EasyPostTracker,
  detail: EasyPostTrackingDetail,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    easypostStatus: detail.status ?? tracker.status ?? null,
    easypostStatusDetail: detail.status_detail ?? null,
  };
  if (typeof detail.message === "string" && detail.message.trim()) {
    data.message = detail.message.trim();
  }
  if (typeof detail.source === "string" && detail.source.trim()) {
    data.scanSource = detail.source.trim();
  }
  if (typeof tracker.est_delivery_date === "string" && tracker.est_delivery_date.trim()) {
    data.estimatedDeliveryDate = tracker.est_delivery_date.trim();
  }
  if (typeof tracker.signed_by === "string" && tracker.signed_by.trim()) {
    data.signedBy = tracker.signed_by.trim();
  }
  return data;
}

function trackerStatusEventData(tracker: EasyPostTracker): Record<string, unknown> {
  return {
    easypostStatus: tracker.status ?? null,
    easypostStatusDetail: tracker.status_detail ?? null,
  };
}

function parseOccurredAt(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}
