import type { ProofStatus } from "./api/types";

export function shortId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 10)}…${id.slice(-6)}`;
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function lifecycleLabel(status: ProofStatus | string): string {
  if (status === "FINALIZED") {
    return "Completed";
  }
  if (status === "OPEN" || status === "AWAITING_PARTICIPANT") {
    return "Pending";
  }
  return "Active";
}

export function statusLabel(status: ProofStatus | string): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "AWAITING_PARTICIPANT":
      return "Awaiting participant";
    case "READY_FOR_EVIDENCE":
      return "Ready for evidence";
    case "EVIDENCE_COMMITTED":
      return "Evidence committed";
    case "FINALIZED":
      return "Finalized";
    default:
      return status;
  }
}

export function eventLabel(eventType: string): string {
  switch (eventType) {
    case "PROOF_CREATED":
      return "Proof created";
    case "PARTICIPANT_INVITED":
      return "Participant invited";
    case "PARTICIPANT_JOINED":
      return "Participant joined";
    case "EVIDENCE_UPLOAD_CREATED":
      return "Evidence upload created";
    case "EVIDENCE_COMMITTED":
      return "Evidence committed";
    case "ATTESTATION_COMMITTED":
      return "Attestation recorded";
    case "PROOF_FINALIZED":
      return "Proof finalized";
    case "EXTERNAL_REFERENCE_BOUND":
      return "External identity bound";
    case "TRANSACTION_IMPORTED":
      return "Transaction imported";
    case "SHIPPING_DETAILS_IMPORTED":
      return "Shipping details imported";
    case "TRANSACTION_DETAILS_UPDATED":
      return "Transaction details updated";
    case "SHIPPING_DETAILS_UPDATED":
      return "Shipping details updated";
    case "SHIPMENT_EVENT_RECORDED":
      return "Shipment observation recorded";
    default:
      return eventType.replaceAll("_", " ").toLowerCase();
  }
}

export function attestationLabel(statement: string): string {
  switch (statement) {
    case "PACKED_DESCRIBED_ITEM":
      return "I packed the described item.";
    case "RECEIVED_PACKAGE":
      return "I received this package.";
    default:
      return statement;
  }
}

export function factLabel(name: string): string {
  switch (name) {
    case "PROOF_RECORDED":
      return "Proof recorded";
    case "PARTICIPANT_RECORDED":
      return "Participant recorded";
    case "EVIDENCE_RECORD_RECEIVED":
      return "Evidence record received";
    case "EVIDENCE_DIGEST_RECORDED":
      return "Evidence digest recorded";
    case "MANIFEST_DIGEST_RECORDED":
      return "Manifest digest recorded";
    case "PROOF_FINALIZED":
      return "Proof finalized";
    default:
      return name.replaceAll("_", " ").toLowerCase();
  }
}

export function externalFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    "transaction.externalReference": "Transaction reference",
    "transaction.transactionDate": "Transaction date",
    "transaction.itemTitle": "Item title",
    "transaction.itemDescription": "Item description",
    "transaction.quantity": "Quantity",
    "transaction.transactionValue": "Transaction value",
    "transaction.currency": "Currency",
    "transaction.metadata": "Transaction metadata",
    "shipping.carrier": "Carrier",
    "shipping.service": "Shipping service",
    "shipping.trackingNumber": "Tracking number",
    "shipping.shipmentDate": "Shipment date",
    "transaction.provenance.source": "Import source",
    "transaction.provenance.provider": "Import provider",
    "transaction.provenance.adapterKey": "Import adapter",
    "transaction.provenance.tenantKey": "Import tenant",
  };
  return labels[field] ?? field;
}

export function chronologyCategoryLabel(
  category: string,
  source?: string,
  provider?: string | null,
): string {
  if (category === "COMMERCE") {
    return "Commerce event";
  }
  if (category === "SHIPMENT") {
    if (source === "PARTICIPANT_SUPPLIED") {
      return "Participant observation";
    }
    if (provider === "easypost") {
      return "Carrier observation via EasyPost";
    }
    return "Carrier observation";
  }
  return "PackProof event";
}

export function displayValue(value: unknown): string {
  if (value == null || value === "") {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
