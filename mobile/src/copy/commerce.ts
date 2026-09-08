import { providerDisplay } from "./status";

export const ETSY_ATTRIBUTION = "Etsy is a trademark of Etsy, Inc. PackProof uses the Etsy API but is not endorsed or certified by Etsy, Inc.";

export function orderReviewReason(code: string): string {
  switch (code) {
    case "etsy_multiple_shipments": return "Multiple shipments";
    case "etsy_partial_shipment": return "Partially shipped";
    case "etsy_mixed_physical_and_digital_order": return "Mixed physical and digital items";
    case "etsy_digital_or_unknown_fulfillment": return "Unconfirmed fulfillment type";
    case "etsy_unknown_fulfillment": return "Unconfirmed fulfillment type";
    case "etsy_inconsistent_currency": return "Inconsistent order currency";
    case "etsy_unconfirmed_order_status": return "Unconfirmed order status";
    case "etsy_incomplete_fulfillment_details": return "Incomplete fulfillment details";
    default: return "Order details need review";
  }
}

export function orderIntakeExplanation(provider: string): string {
  if (provider.toLowerCase() === "etsy") {
    return "Enabling automatic intake checks existing paid, unshipped physical orders first, then checks for later orders even when PackProof is closed. Digital, unpaid, cancelled, refunded and partially shipped orders are excluded. Record the packing and submit your attestation yourself; connecting never completes an order in Etsy.";
  }
  return "Paid physical orders with remaining fulfillment enter Orders automatically while this is enabled, even when PackProof is closed. Digital, unpaid, cancelled and fully fulfilled orders are excluded. Recording always remains a deliberate action.";
}

export function providerSetupMessage(provider: string): string {
  return provider.toLowerCase() === "etsy"
    ? "Etsy connection setup is pending. PackProof needs an approved Etsy app and completed server configuration before you can authorize your shop."
    : `${providerDisplay(provider)} is not enabled in this environment.`;
}

export function automaticIntakeStatus(connection: {
  status: string;
  autoSyncEnabled?: boolean;
  sync?: { initialSyncCompletedAt?: string | null; runStatus?: string };
}): string {
  if (connection.status === "NEEDS_REAUTH") return "Automatic intake paused. Reconnect your selling account above.";
  if (connection.status !== "ACTIVE") return "Automatic intake unavailable while this connection needs attention.";
  if (!connection.autoSyncEnabled) return "Automatic intake off";
  if (connection.sync?.runStatus === "FAILED") return "Automatic intake needs attention. Check the connection error below.";
  if (connection.sync?.runStatus === "RETRYING") return "The last order check could not finish. Automatic intake will retry.";
  return connection.sync?.initialSyncCompletedAt
    ? "Automatic intake enabled"
    : "Initial order check pending or in progress";
}
