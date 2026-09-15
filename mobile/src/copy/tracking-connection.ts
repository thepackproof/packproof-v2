/** Connection describes carrier updates separately from the sealed recording. */
export function trackingConnectionLabel(input: {
  hasNumber: boolean;
  registered: boolean;
  hasEvents: boolean;
  errorCode?: string | null;
}): string {
  if (input.errorCode) return 'Tracking connection needs attention';
  if (input.hasEvents) return 'Carrier updates received';
  if (input.registered) return 'Waiting for the first carrier update';
  if (input.hasNumber) return 'Tracking number saved · connection pending';
  return 'Tracking not connected';
}

export const TRACKING_CARRIERS = [
  ['usps', 'USPS'], ['ups', 'UPS'], ['fedex', 'FedEx'], ['dhl_express', 'DHL'],
] as const;
