import { DomainError } from "../domain/errors.js";

const ALLOWED_KEYS = new Set([
  "adapter",
  "adapterKey",
  "externalTransactionId",
  "createProof",
  "mode",
]);

export interface IntegrationImportRequest {
  adapterKey: string;
  externalTransactionId: string | null;
  createProof: boolean;
}

export function parseIntegrationImportRequest(body: unknown): IntegrationImportRequest {
  const record =
    body != null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new DomainError(
        "INTEGRATION_INPUT_NOT_ALLOWED",
        "This route does not accept provider facts or raw marketplace payloads",
        400,
      );
    }
  }
  if (record.mode != null && record.mode !== "reference") {
    throw new DomainError(
      "INTEGRATION_TRUST_BOUNDARY",
      "This route accepts reference adapters only",
      403,
    );
  }
  const adapterKeyRaw = record.adapterKey ?? record.adapter;
  if (typeof adapterKeyRaw !== "string" || !adapterKeyRaw.trim()) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "adapterKey is required", 400);
  }
  const adapterKey = adapterKeyRaw.trim();
  let externalTransactionId: string | null = null;
  if (record.externalTransactionId != null) {
    if (typeof record.externalTransactionId !== "string") {
      throw new DomainError(
        "INVALID_IMPORTED_TRANSACTION",
        "externalTransactionId must be a string",
        400,
      );
    }
    const trimmed = record.externalTransactionId.trim();
    externalTransactionId = trimmed || null;
  }
  const createProof = record.createProof === true;
  return { adapterKey, externalTransactionId, createProof };
}
