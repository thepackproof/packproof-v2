import type { Clock } from "../clock.js";
import type { ImportedShipmentEvent } from "../domain/imported-shipment-event.js";
import type { ShipmentObservationAdapter } from "./shipment-adapter.js";

export const DEMO_CARRIER_ADAPTER_KEY = "demo-carrier";
export const DEMO_CARRIER_TRACKING = "1Z999AA10123456784";

export const DEMO_CARRIER_TIMELINE_TYPES = [
  "LABEL_CREATED",
  "CARRIER_ACCEPTED",
  "WEIGHT_RECORDED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

const TIMELINE: Array<{
  eventType: (typeof DEMO_CARRIER_TIMELINE_TYPES)[number];
  occurredAt: string;
  locationText: string | null;
  eventData: Record<string, unknown>;
}> = [
  {
    eventType: "LABEL_CREATED",
    occurredAt: "2026-08-21T12:00:00.000Z",
    locationText: null,
    eventData: {},
  },
  {
    eventType: "CARRIER_ACCEPTED",
    occurredAt: "2026-08-21T16:08:00.000Z",
    locationText: null,
    eventData: {},
  },
  {
    eventType: "WEIGHT_RECORDED",
    occurredAt: "2026-08-21T16:16:00.000Z",
    locationText: null,
    eventData: { weightLb: 3.8, unit: "lb" },
  },
  {
    eventType: "IN_TRANSIT",
    occurredAt: "2026-09-01T14:40:00.000Z",
    locationText: "Columbus, OH",
    eventData: {},
  },
  {
    eventType: "OUT_FOR_DELIVERY",
    occurredAt: "2026-09-02T12:10:00.000Z",
    locationText: null,
    eventData: {},
  },
  {
    eventType: "DELIVERED",
    occurredAt: "2026-09-02T16:16:00.000Z",
    locationText: null,
    eventData: {},
  },
];

export function createDemoCarrierAdapter(_clock: Clock): ShipmentObservationAdapter {
  return {
    adapterKey: DEMO_CARRIER_ADAPTER_KEY,
    kind: "reference",
    async fetchShipmentEvents(input) {
      const trackingNumber = input.trackingNumber?.trim() || DEMO_CARRIER_TRACKING;
      return TIMELINE.map((step) => {
        const event: ImportedShipmentEvent = {
          eventType: step.eventType,
          occurredAt: step.occurredAt,
          carrier: "UPS",
          locationText: step.locationText,
          source: "SHIPPING_PROVIDER_API",
          provider: DEMO_CARRIER_ADAPTER_KEY,
          sourceEventId: `${DEMO_CARRIER_ADAPTER_KEY}:${input.transactionId}:${step.eventType}`,
          eventData: { ...step.eventData, trackingNumber },
          payloadSha256: null,
        };
        return event;
      });
    },
  };
}
