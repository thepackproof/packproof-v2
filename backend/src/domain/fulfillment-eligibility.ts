export const NORMALIZED_PAYMENT_STATES = [
  "CONFIRMED",
  "PENDING",
  "FAILED",
  "REFUNDED",
  "UNKNOWN",
] as const;

export type NormalizedPaymentState = (typeof NORMALIZED_PAYMENT_STATES)[number];

export const NORMALIZED_FULFILLMENT_STATES = [
  "AWAITING_FULFILLMENT",
  "IN_PROGRESS",
  "FULFILLED",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type NormalizedFulfillmentState = (typeof NORMALIZED_FULFILLMENT_STATES)[number];

export const FULFILLMENT_ELIGIBILITIES = ["FULFILLMENT_ELIGIBLE", "INELIGIBLE"] as const;
export type FulfillmentEligibility = (typeof FULFILLMENT_ELIGIBILITIES)[number];

export interface FulfillmentEligibilityInput {
  paymentState: NormalizedPaymentState | string;
  fulfillmentState: NormalizedFulfillmentState | string;
  requiresPhysicalFulfillment: boolean;
  cancelled: boolean;
}

/**
 * Automatic Proof creation is allowed only when payment is confirmed, the
 * order still needs physical fulfillment, and it is not cancelled or already
 * fully fulfilled. Partially fulfilled (`IN_PROGRESS`) physical orders remain
 * eligible. This is not Proof lifecycle state.
 */
export function decideFulfillmentEligibility(
  input: FulfillmentEligibilityInput,
): FulfillmentEligibility {
  if (input.cancelled) {
    return "INELIGIBLE";
  }
  if (!input.requiresPhysicalFulfillment) {
    return "INELIGIBLE";
  }
  if (input.paymentState !== "CONFIRMED") {
    return "INELIGIBLE";
  }
  if (input.fulfillmentState === "FULFILLED" || input.fulfillmentState === "CANCELLED") {
    return "INELIGIBLE";
  }
  if (
    input.fulfillmentState !== "AWAITING_FULFILLMENT" &&
    input.fulfillmentState !== "IN_PROGRESS"
  ) {
    return "INELIGIBLE";
  }
  return "FULFILLMENT_ELIGIBLE";
}

export function isFulfillmentEligible(input: FulfillmentEligibilityInput): boolean {
  return decideFulfillmentEligibility(input) === "FULFILLMENT_ELIGIBLE";
}
