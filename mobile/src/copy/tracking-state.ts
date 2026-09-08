import type { ProofView, ShipmentEventView } from "../v2-api";

export type TrackingState = { kind: "missing_label" | "unavailable" | "failed" | "pending" | "awaiting_scan" | "reported"; title: string; detail: string };
export function trackingState(input: {
  trackingNumber?: string | null;
  events: ShipmentEventView[];
  sync?: ProofView["shipmentSync"];
  registration?: NonNullable<ProofView["captureShipping"]>["registration"];
  refreshError?: string | null;
}): TrackingState {
  const { registration, sync } = input;
  if (input.refreshError) return { kind: "failed", title: "Tracking update unavailable", detail: "The latest refresh did not complete. Any earlier carrier reports remain available below." };
  if (registration?.state === "FAILED") return { kind: "failed", title: "Tracking needs attention", detail: "The tracking number is kept, but the carrier lookup did not complete. Try updating tracking again." };
  if (registration?.errorCode === "SHIPPO_TEST_TRACKING_ONLY" || registration?.mode === "test") return { kind: "unavailable", title: "Test tracking only", detail: "This connection cannot confirm live movement for this package. Test reports are labeled separately." };
  if (!input.trackingNumber && !input.events.length) return { kind: "missing_label", title: "No tracking number recorded", detail: "A shipping label has not been attached to this Proof. This does not change the saved recording." };
  if (registration?.state === "WAITING_FOR_CONNECTION" || (sync?.connectionId && sync.status !== "ACTIVE")) return { kind: "unavailable", title: "Tracking service unavailable", detail: "The carrier connection needs attention. Any previously recorded reports are retained." };
  if (registration?.errorCode === "SHIPMENT_CARRIER_REQUIRED") return { kind: "pending", title: "Carrier not identified", detail: "The tracking number is attached. PackProof cannot request carrier updates until its carrier is known." };
  if (input.events.length) return { kind: "reported", title: "Carrier reports", detail: "These are reported observations, not live GPS." };
  if (registration && registration.state !== "REGISTERED") return { kind: "pending", title: "Tracking connection pending", detail: "The tracking number is attached. PackProof has not confirmed a carrier connection yet." };
  if (sync?.available || registration?.state === "REGISTERED") return { kind: "awaiting_scan", title: "No carrier scan yet", detail: "Tracking is connected, but the carrier has not supplied a shipment scan." };
  return { kind: "unavailable", title: "Carrier tracking is not connected", detail: "The tracking number is attached, but live carrier updates are not available for this Proof." };
}
