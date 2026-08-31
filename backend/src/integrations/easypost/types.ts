export interface EasyPostTrackingLocation {
  object?: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zip?: string | null;
}

export interface EasyPostTrackingDetail {
  object?: string;
  message?: string | null;
  description?: string | null;
  status?: string | null;
  status_detail?: string | null;
  datetime?: string | null;
  source?: string | null;
  carrier_code?: string | null;
  tracking_location?: EasyPostTrackingLocation | null;
  est_delivery_date?: string | null;
}

export interface EasyPostCarrierDetail {
  object?: string;
  service?: string | null;
  container_type?: string | null;
  est_delivery_date_local?: string | null;
  est_delivery_time_local?: string | null;
  origin_location?: string | null;
  destination_location?: string | null;
}

export interface EasyPostTracker {
  id?: string;
  object?: string;
  mode?: string | null;
  tracking_code?: string | null;
  status?: string | null;
  status_detail?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  signed_by?: string | null;
  weight?: number | string | null;
  est_delivery_date?: string | null;
  carrier?: string | null;
  tracking_details?: EasyPostTrackingDetail[] | null;
  carrier_detail?: EasyPostCarrierDetail | null;
}

export interface EasyPostEvent {
  id?: string;
  object?: string;
  description?: string | null;
  mode?: string | null;
  result?: EasyPostTracker | Record<string, unknown> | null;
}

export const EASYPOST_TEST_TRACKING_CODES = {
  pre_transit: "EZ1000000001",
  in_transit: "EZ2000000002",
  out_for_delivery: "EZ3000000003",
  delivered: "EZ4000000004",
  return_to_sender: "EZ5000000005",
  failure: "EZ6000000006",
  unknown: "EZ7000000007",
} as const;
