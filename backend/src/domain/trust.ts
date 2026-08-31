export const CANONICAL_PROOF_SCHEMA = "packproof.proof.canonical/v1" as const;
export const PROOF_SUMMARY_SCHEMA = "packproof.proof.summary/v1" as const;
export const SHIPMENT_SUPPLEMENT_SCHEMA = "packproof.shipment.supplement/v1" as const;
export const SHIPMENT_INTEGRITY_SCHEMA = "packproof.shipment.integrity/v1" as const;

export const TRUST_KIND = {
  FACT: "FACT",
  ATTESTATION: "ATTESTATION",
  EXTERNAL: "EXTERNAL",
} as const;

export type TrustKind = (typeof TRUST_KIND)[keyof typeof TRUST_KIND];

export const ATTESTATION_STATEMENTS = [
  "PACKED_DESCRIBED_ITEM",
  "RECEIVED_PACKAGE",
] as const;

export type AllowedAttestationStatement = (typeof ATTESTATION_STATEMENTS)[number];

export const PACKPROOF_TRANSACTION_TENANT = "packproof:transaction";

export const DIGEST_ALGORITHM = "SHA-256";
