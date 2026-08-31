import type { EasyPostTracker, EasyPostTrackingDetail } from "../../src/integrations/easypost/types.js";

export function trackingDetail(input: {
  status: string;
  datetime: string;
  message?: string;
  statusDetail?: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  source?: string;
}): EasyPostTrackingDetail {
  return {
    object: "TrackingDetail",
    message: input.message ?? input.status,
    description: "",
    status: input.status,
    status_detail: input.statusDetail ?? "status_update",
    datetime: input.datetime,
    source: input.source ?? "UPS",
    carrier_code: "",
    tracking_location: {
      object: "TrackingLocation",
      city: input.city === undefined ? "COLUMBUS" : input.city,
      state: input.state === undefined ? "OH" : input.state,
      country: input.country === undefined ? "US" : input.country,
      zip: input.zip === undefined ? "43215" : input.zip,
    },
    est_delivery_date: null,
  };
}

export function trackerFixture(input: {
  id?: string;
  trackingCode: string;
  status: string;
  statusDetail?: string;
  carrier?: string;
  mode?: string;
  weight?: number | null;
  details: EasyPostTrackingDetail[];
  carrierDetail?: boolean;
}): EasyPostTracker {
  return {
    id: input.id ?? `trk_${input.trackingCode.toLowerCase()}`,
    object: "Tracker",
    mode: input.mode ?? "test",
    tracking_code: input.trackingCode,
    status: input.status,
    status_detail: input.statusDetail ?? "status_update",
    created_at: "2026-08-21T12:00:00Z",
    updated_at: "2026-08-22T16:00:00Z",
    signed_by: input.status === "delivered" ? "A Buyer" : null,
    weight: input.weight ?? null,
    est_delivery_date: "2026-08-24T20:00:00Z",
    shipment_id: null,
    carrier: input.carrier ?? "UPS",
    tracking_details: input.details,
    carrier_detail:
      input.carrierDetail === false
        ? null
        : {
            object: "CarrierDetail",
            service: "Ground",
            container_type: null,
            est_delivery_date_local: null,
            est_delivery_time_local: null,
            origin_location: "COLUMBUS OH, 43215",
            destination_location: "CHARLESTON SC, 29401",
          },
  };
}

export const PRE_TRANSIT = trackerFixture({
  trackingCode: "EZ1000000001",
  status: "pre_transit",
  statusDetail: "label_created",
  details: [
    trackingDetail({
      status: "pre_transit",
      statusDetail: "label_created",
      datetime: "2026-08-21T12:00:00Z",
      message: "Shipping Label Created",
      city: null,
      state: null,
      zip: null,
      country: null,
    }),
  ],
});

export const IN_TRANSIT = trackerFixture({
  trackingCode: "EZ2000000002",
  status: "in_transit",
  details: [
    trackingDetail({
      status: "pre_transit",
      statusDetail: "label_created",
      datetime: "2026-08-21T12:00:00Z",
      message: "Shipping Label Created",
      city: null,
      state: null,
      zip: null,
      country: null,
    }),
    trackingDetail({
      status: "in_transit",
      statusDetail: "departed_origin_facility",
      datetime: "2026-08-21T18:00:00Z",
      message: "Departed EasyPost",
    }),
    trackingDetail({
      status: "in_transit",
      statusDetail: "arrived_at_facility",
      datetime: "2026-08-22T09:10:00Z",
      message: "Arrived at Facility",
      city: "INDIANAPOLIS",
      state: "IN",
      zip: "46241",
    }),
    trackingDetail({
      status: "in_transit",
      datetime: "2026-08-22T16:40:00Z",
      message: "In Transit",
      city: "LOUISVILLE",
      state: "KY",
      zip: "40213",
    }),
  ],
});

export const OUT_FOR_DELIVERY = trackerFixture({
  trackingCode: "EZ3000000003",
  status: "out_for_delivery",
  details: [
    ...IN_TRANSIT.tracking_details!,
    trackingDetail({
      status: "out_for_delivery",
      statusDetail: "out_for_delivery",
      datetime: "2026-08-23T13:05:00Z",
      message: "Out for Delivery",
      city: "CHARLESTON",
      state: "SC",
      zip: "29401",
    }),
  ],
});

export const DELIVERED = trackerFixture({
  trackingCode: "EZ4000000004",
  status: "delivered",
  weight: 12.5,
  details: [
    ...OUT_FOR_DELIVERY.tracking_details!,
    trackingDetail({
      status: "delivered",
      datetime: "2026-08-23T16:16:00Z",
      message: "Delivered",
      city: "CHARLESTON",
      state: "SC",
      zip: "29401",
    }),
  ],
});

export const RETURN_TO_SENDER = trackerFixture({
  trackingCode: "EZ5000000005",
  status: "return_to_sender",
  details: [
    trackingDetail({
      status: "return_to_sender",
      statusDetail: "return",
      datetime: "2026-08-24T11:00:00Z",
      message: "Returning to sender",
    }),
  ],
});

export const FAILURE = trackerFixture({
  trackingCode: "EZ6000000006",
  status: "failure",
  details: [
    trackingDetail({
      status: "failure",
      statusDetail: "delivery_exception",
      datetime: "2026-08-24T11:00:00Z",
      message: "Delivery exception",
    }),
  ],
});

export const UNKNOWN = trackerFixture({
  trackingCode: "EZ7000000007",
  status: "unknown",
  details: [
    trackingDetail({
      status: "unknown",
      datetime: "2026-08-24T11:00:00Z",
      message: "Status unknown",
    }),
  ],
});

export const TRACKERS_BY_CODE: Record<string, EasyPostTracker> = {
  EZ1000000001: PRE_TRANSIT,
  EZ2000000002: IN_TRANSIT,
  EZ3000000003: OUT_FOR_DELIVERY,
  EZ4000000004: DELIVERED,
  EZ5000000005: RETURN_TO_SENDER,
  EZ6000000006: FAILURE,
  EZ7000000007: UNKNOWN,
};
