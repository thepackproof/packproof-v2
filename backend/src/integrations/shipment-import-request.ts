import { DomainError } from "../domain/errors.js";

const ALLOWED_KEYS = new Set([
  "adapter",
  "adapterKey",
  "mode",
  "transactionId",
  "externalTransactionId",
  "throughEventType",
]);

export interface ShipmentImportRequest {
  adapterKey: string;
  transactionId: string | null;
  externalTransactionId: string | null;
  throughEventType: string | null;
}

export function parseShipmentImportRequest(body: unknown): ShipmentImportRequest {
  const record =
    body != null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new DomainError(
        "INTEGRATION_INPUT_NOT_ALLOWED",
        "This route does not accept carrier facts or raw provider payloads",
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
    throw new DomainError("INVALID_SHIPMENT_EVENT", "adapterKey is required", 400);
  }
  const transactionId = optionalString(record.transactionId, "transactionId");
  const externalTransactionId = optionalString(
    record.externalTransactionId,
    "externalTransactionId",
  );
  if (!transactionId && !externalTransactionId) {
    throw new DomainError(
      "INVALID_SHIPMENT_EVENT",
      "transactionId or externalTransactionId is required",
      400,
    );
  }
  return {
    adapterKey: adapterKeyRaw.trim(),
    transactionId,
    externalTransactionId,
    throughEventType: optionalString(record.throughEventType, "throughEventType"),
  };
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_SHIPMENT_EVENT", `${field} must be a string`, 400);
  }
  const trimmed = value.trim();
  return trimmed || null;
}
