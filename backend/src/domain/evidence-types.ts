import { DomainError } from "./errors.js";

export const EVIDENCE_TYPES = ["SELLER_EVIDENCE", "FULFILLMENT_CAPTURE"] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const DEFAULT_EVIDENCE_TYPE: EvidenceType = "SELLER_EVIDENCE";

export const QUALIFYING_FULFILLMENT_CAPTURE_TYPES: ReadonlySet<string> = new Set([
  "FULFILLMENT_CAPTURE",
]);

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

export function parseEvidenceType(value: unknown): EvidenceType {
  if (value == null || value === "") {
    return DEFAULT_EVIDENCE_TYPE;
  }
  if (!isEvidenceType(value)) {
    throw new DomainError(
      "INVALID_EVIDENCE_TYPE",
      "evidenceType must be SELLER_EVIDENCE or FULFILLMENT_CAPTURE",
      400,
    );
  }
  return value;
}

export function isQualifyingFulfillmentCapture(input: {
  evidenceType: string;
  validationStatus: string;
}): boolean {
  return (
    input.validationStatus === "COMMITTED" &&
    QUALIFYING_FULFILLMENT_CAPTURE_TYPES.has(input.evidenceType)
  );
}
