import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import {
  parseShippingWrite,
  parseTransactionCreate,
  shippingWriteHasValues,
  type ShippingWrite,
} from "./transaction-fields.js";
import {
  requireProvenanceSource,
  type ImportedBuyer,
  type ProvenanceSource,
} from "./provenance.js";

export interface ImportedTransaction {
  provider: string;
  externalTransactionId: string;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  } | null;
  buyer?: {
    externalId?: string | null;
    displayName?: string | null;
    email?: string | null;
  } | null;
  provenance: {
    source: ProvenanceSource | string;
    sourceRecordId?: string | null;
    importedAt: string;
  };
}

export interface ParsedImportedTransaction {
  provider: string;
  externalTransactionId: string;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  shipping: ShippingWrite | null;
  buyer: ImportedBuyer | null;
  provenance: {
    source: ProvenanceSource;
    sourceRecordId: string | null;
    importedAt: string;
  };
}

const PROVIDER_MAX = 80;
const SHORT_MAX = 200;

export function parseImportedTransaction(input: unknown): ParsedImportedTransaction {
  const record = asRecord(input);
  const provider = normalizeProvider(record.provider);
  const source = requireProvenanceSource(asRecord(record.provenance).source);
  if (source === "PARTICIPANT_SUPPLIED") {
    throw new DomainError(
      "INVALID_IMPORTED_TRANSACTION",
      "Participant-supplied data uses manual transaction creation, not import",
      400,
    );
  }
  const parsedFields = parseTransactionCreate({
    externalReference: record.externalTransactionId,
    transactionDate: record.transactionDate,
    itemTitle: record.itemTitle,
    itemDescription: record.itemDescription,
    quantity: record.quantity,
    transactionValue: record.transactionValue,
    currency: record.currency,
    shipping: record.shipping ?? null,
  });
  if (!parsedFields.externalReference) {
    throw new DomainError(
      "INVALID_IMPORTED_TRANSACTION",
      "externalTransactionId is required",
      400,
    );
  }
  const provenanceRecord = asRecord(record.provenance);
  const importedAt = normalizeImportedAt(provenanceRecord.importedAt);
  const sourceRecordId = normalizeOptionalText(provenanceRecord.sourceRecordId, "sourceRecordId");
  const shipping =
    record.shipping == null ? null : parseShippingWrite(record.shipping);
  return {
    provider,
    externalTransactionId: parsedFields.externalReference,
    transactionDate: parsedFields.transactionDate,
    itemTitle: parsedFields.itemTitle,
    itemDescription: parsedFields.itemDescription,
    quantity: parsedFields.quantity,
    transactionValue: parsedFields.transactionValue,
    currency: parsedFields.currency,
    shipping: shipping && shippingWriteHasValues(shipping) ? shipping : shipping,
    buyer: parseBuyer(record.buyer),
    provenance: {
      source,
      sourceRecordId,
      importedAt,
    },
  };
}

export function importedPayloadFingerprint(parsed: ParsedImportedTransaction): string {
  return sha256Hex(
    canonicalize({
      provider: parsed.provider,
      externalTransactionId: parsed.externalTransactionId,
      transactionDate: parsed.transactionDate,
      itemTitle: parsed.itemTitle,
      itemDescription: parsed.itemDescription,
      quantity: parsed.quantity,
      transactionValue: parsed.transactionValue,
      currency: parsed.currency,
      shipping: parsed.shipping,
      buyer: parsed.buyer,
      provenance: {
        source: parsed.provenance.source,
        sourceRecordId: parsed.provenance.sourceRecordId,
      },
    }),
  );
}

function parseBuyer(value: unknown): ImportedBuyer | null {
  if (value == null) {
    return null;
  }
  const record = asRecord(value);
  const buyer: ImportedBuyer = {
    externalId: normalizeOptionalText(record.externalId, "buyer.externalId"),
    displayName: normalizeOptionalText(record.displayName, "buyer.displayName"),
    email: normalizeOptionalText(record.email, "buyer.email"),
  };
  if (!buyer.externalId && !buyer.displayName && !buyer.email) {
    return null;
  }
  return buyer;
}

function normalizeProvider(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "provider is required", 400);
  }
  const provider = value.trim().toLowerCase();
  if (!provider || provider.length > PROVIDER_MAX || !/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "provider is invalid", 400);
  }
  return provider;
}

function normalizeImportedAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "provenance.importedAt is required", 400);
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "provenance.importedAt is invalid", 400);
  }
  return date.toISOString();
}

function normalizeOptionalText(value: unknown, field: string): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", `${field} must be a string`, 400);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > SHORT_MAX) {
    throw new DomainError(
      "INVALID_IMPORTED_TRANSACTION",
      `${field} must be at most ${SHORT_MAX} characters`,
      400,
    );
  }
  return trimmed;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}
