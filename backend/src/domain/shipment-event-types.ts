import { DomainError } from "./errors.js";

export const SHIPMENT_EVENT_TYPES = [
  "LABEL_CREATED",
  "CARRIER_ACCEPTED",
  "WEIGHT_RECORDED",
  "IN_TRANSIT",
  "ARRIVED_AT_FACILITY",
  "DEPARTED_FACILITY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_EXCEPTION",
  "RETURN_TO_SENDER",
  "RETURN_IN_TRANSIT",
  "RETURN_DELIVERED",
  "CARRIER_EVENT",
] as const;

export type ShipmentEventType = (typeof SHIPMENT_EVENT_TYPES)[number];

const TYPE_SET = new Set<string>(SHIPMENT_EVENT_TYPES);

const ALIASES: Record<string, ShipmentEventType> = {
  LABEL_CREATED: "LABEL_CREATED",
  LABELCREATED: "LABEL_CREATED",
  PRE_TRANSIT: "LABEL_CREATED",
  PRETRANSIT: "LABEL_CREATED",
  CARRIER_ACCEPTED: "CARRIER_ACCEPTED",
  ACCEPTED: "CARRIER_ACCEPTED",
  ORIGIN_SCAN: "CARRIER_ACCEPTED",
  PICKUP: "CARRIER_ACCEPTED",
  WEIGHT_RECORDED: "WEIGHT_RECORDED",
  WEIGHED: "WEIGHT_RECORDED",
  WEIGHT: "WEIGHT_RECORDED",
  IN_TRANSIT: "IN_TRANSIT",
  INTRANSIT: "IN_TRANSIT",
  I: "IN_TRANSIT",
  IT: "IN_TRANSIT",
  ARRIVED_AT_FACILITY: "ARRIVED_AT_FACILITY",
  ARRIVED: "ARRIVED_AT_FACILITY",
  AR: "ARRIVED_AT_FACILITY",
  DEPARTED_FACILITY: "DEPARTED_FACILITY",
  DEPARTED: "DEPARTED_FACILITY",
  DP: "DEPARTED_FACILITY",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  OUTFORDELIVERY: "OUT_FOR_DELIVERY",
  OFD: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  D: "DELIVERED",
  DELIVERY: "DELIVERED",
  DELIVERY_EXCEPTION: "DELIVERY_EXCEPTION",
  EXCEPTION: "DELIVERY_EXCEPTION",
  X: "DELIVERY_EXCEPTION",
  DELAY: "DELIVERY_EXCEPTION",
  RETURN_TO_SENDER: "RETURN_TO_SENDER",
  RTS: "RETURN_TO_SENDER",
  RETURN: "RETURN_TO_SENDER",
  RETURN_IN_TRANSIT: "RETURN_IN_TRANSIT",
  RETURN_DELIVERED: "RETURN_DELIVERED",
  CARRIER_EVENT: "CARRIER_EVENT",
  OTHER: "CARRIER_EVENT",
};

export interface NormalizedShipmentEventType {
  eventType: ShipmentEventType;
  carrierStatus: string | null;
}

export function isShipmentEventType(value: unknown): value is ShipmentEventType {
  return typeof value === "string" && TYPE_SET.has(value);
}

export function normalizeShipmentEventType(value: unknown): NormalizedShipmentEventType {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_SHIPMENT_EVENT", "eventType is required", 400);
  }
  const original = value.trim();
  const key = original.toUpperCase().replace(/[\s-]+/g, "_");
  const mapped = ALIASES[key];
  if (mapped) {
    return {
      eventType: mapped,
      carrierStatus: mapped === "CARRIER_EVENT" && !TYPE_SET.has(original) ? original : null,
    };
  }
  return { eventType: "CARRIER_EVENT", carrierStatus: original };
}

export function shipmentEventTypeOrderIndex(eventType: ShipmentEventType): number {
  return SHIPMENT_EVENT_TYPES.indexOf(eventType);
}
