export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 422,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "23505") {
    return true;
  }
  const message = (candidate.message ?? "").toLowerCase();
  return (
    message.includes("duplicate key") ||
    message.includes("unique constraint") ||
    message.includes("unique violation")
  );
}

export function errorCodeFromSql(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const codes = [
    "PROOF_ALREADY_FINALIZED",
    "EVIDENCE_ALREADY_COMMITTED",
    "AUDIT_IMMUTABLE",
    "MANIFEST_IMMUTABLE",
    "ATTESTATION_IMMUTABLE",
    "EXTERNAL_REFERENCE_IMMUTABLE",
    "INTEGRATION_IDENTITY_IMMUTABLE",
    "SHIPMENT_EVENT_IMMUTABLE",
    "PARTICIPATION_POLICY_IMMUTABLE",
    "WORKFLOW_TYPE_IMMUTABLE",
    "WORKFLOW_VERSION_IMMUTABLE",
    "COMMERCE_ORDER_REBIND",
    "ASSET_BINDING_IMMUTABLE",
    "OBSERVATION_IMMUTABLE",
    "OBSERVATION_EVIDENCE_INVALID",
    "OBSERVATION_ASSET_INVALID",
    "TRANSFER_PROOF_MISMATCH",
    "CONTINUITY_IMMUTABLE",
  ];
  return codes.find((code) => message.includes(code)) ?? null;
}
