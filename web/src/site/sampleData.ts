import type { ChronologyEntry, ProofCollectionItem } from "../api/types";
import type { TrackingObservation } from "../components/ShipmentTracking";

// All records in /sample are illustrative and remain separate from workspace data.
export const sampleChronology: ChronologyEntry[] = [
  { id: "sample-order", occurredAt: "2026-09-01T09:41:00Z", category: "COMMERCE", title: "Order added", description: "The order details were connected to this sample Proof.", source: "example", provider: "Example store", relatedEntityId: null, eventType: "ORDER_IMPORTED" },
  { id: "sample-evidence", occurredAt: "2026-09-01T09:44:00Z", category: "PROOF", title: "Illustrative footage added", description: "Illustrative stock footage added to the fictional record. It shows a mug and packing material; no seal or label is shown.", source: "sample", relatedEntityId: null, eventType: "EVIDENCE_COMMITTED" },
  { id: "sample-final", occurredAt: "2026-09-01T09:46:00Z", category: "PROOF", title: "Proof finalized", description: "The core record was frozen with its committed evidence.", source: "sample", relatedEntityId: null, eventType: "PROOF_FINALIZED" },
  { id: "sample-scan", occurredAt: "2026-09-02T14:20:00Z", category: "SHIPMENT", title: "Arrived at facility", description: "Illustrative scan in Columbus, Ohio. This is not a real shipment.", source: "example", provider: "Example carrier", relatedEntityId: null, eventType: "ARRIVED_AT_FACILITY" },
];
export const sampleTracking: TrackingObservation[] = [
  { id: "sample-columbus", eventType: "ARRIVED_AT_FACILITY", occurredAt: "2026-09-02T14:20:00Z", location: "Columbus, Ohio, United States", provider: "Example carrier", source: "Illustrative data", eventData: { latitude: 39.9612, longitude: -82.9988 } },
  { id: "sample-cincinnati", eventType: "IN_TRANSIT", occurredAt: "2026-09-01T18:10:00Z", location: "Cincinnati, Ohio, United States", provider: "Example carrier", source: "Illustrative data", eventData: { latitude: 39.1031, longitude: -84.512 } },
];
export function sampleActivityRecords(): ProofCollectionItem[] {
  return Array.from({ length: 8 }, (_, index) => {
    const date = new Date(); date.setDate(date.getDate() - [6, 5, 5, 3, 2, 2, 1, 0][index]); date.setHours(0, 0, 0, 0);
    const finalized = index < 5;
    return { proofId: `example-${index}`, transactionId: `example-order-${index}`, role: "SELLER", status: finalized ? "FINALIZED" : "DRAFT", createdAt: date.toISOString(), updatedAt: date.toISOString(), finalizedAt: finalized ? date.toISOString() : null, transaction: { externalReference: null, itemTitle: "Illustrative shipment", transactionDate: null, carrier: "Example carrier", trackingNumber: null } };
  });
}
