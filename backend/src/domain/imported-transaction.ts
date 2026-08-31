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
import type { TransactionItemWrite } from "./transaction-items.js";
import { summarizeItems } from "./normalized-fulfillment-order.js";
import { normalizeExternalAccountReference } from "./normalized-fulfillment-order.js";

export interface ImportedTransaction {
  provider: string;
  externalTransactionId: string;
  externalAccountReference?: string | null;
  externalReference?: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  items?: Array<{
    externalItemId?: string | null;
    position?: number;
    title?: string | null;
    description?: string | null;
    sku?: string | null;
    quantity?: number | null;
    unitValue?: number | null;
    currency?: string | null;
  }>;
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
  externalAccountReference: string | null;
  displayExternalReference: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  items: TransactionItemWrite[];
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
  const items = parseImportedItems(record.items);
  const summary = items.length
    ? summarizeItems(items, null, null)
    : {
        itemTitle: null,
        itemDescription: null,
        quantity: null,
        transactionValue: null,
        currency: null,
      };
  const parsedFields = parseTransactionCreate({
    externalReference: record.externalTransactionId,
    transactionDate: record.transactionDate,
    itemTitle: record.itemTitle ?? summary.itemTitle,
    itemDescription: record.itemDescription ?? summary.itemDescription,
    quantity: record.quantity ?? summary.quantity,
    transactionValue: record.transactionValue ?? summary.transactionValue,
    currency: record.currency ?? summary.currency,
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
  const externalAccountReference =
    record.externalAccountReference == null || record.externalAccountReference === ""
      ? null
      : normalizeExternalAccountReference(record.externalAccountReference);
  const displayExternalReference = normalizeOptionalText(
    record.externalReference,
    "externalReference",
  );
  return {
    provider,
    externalTransactionId: parsedFields.externalReference,
    externalAccountReference,
    displayExternalReference,
    transactionDate: parsedFields.transactionDate,
    itemTitle: parsedFields.itemTitle,
    itemDescription: parsedFields.itemDescription,
    quantity: parsedFields.quantity,
    transactionValue: parsedFields.transactionValue,
    currency: parsedFields.currency,
    items,
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
      ...(parsed.externalAccountReference
        ? { externalAccountReference: parsed.externalAccountReference }
        : {}),
      transactionDate: parsed.transactionDate,
      itemTitle: parsed.itemTitle,
      itemDescription: parsed.itemDescription,
      quantity: parsed.quantity,
      transactionValue: parsed.transactionValue,
      currency: parsed.currency,
      shipping: parsed.shipping,
      buyer: parsed.buyer,
      ...(parsed.items.length > 0 ? { items: parsed.items } : {}),
      provenance: {
        source: parsed.provenance.source,
        sourceRecordId: parsed.provenance.sourceRecordId,
      },
    }),
  );
}

function parseImportedItems(value: unknown): TransactionItemWrite[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "items must be an array", 400);
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const position = record.position == null ? index + 1 : Number(record.position);
    if (!Number.isInteger(position) || position <= 0) {
      throw new DomainError("INVALID_IMPORTED_TRANSACTION", "item position is invalid", 400);
    }
    return {
      externalItemId: normalizeOptionalText(record.externalItemId, "items.externalItemId"),
      position,
      title: normalizeOptionalText(record.title, "items.title"),
      description: normalizeOptionalText(record.description, "items.description"),
      sku: normalizeOptionalText(record.sku, "items.sku"),
      quantity:
        record.quantity == null || record.quantity === ""
          ? null
          : typeof record.quantity === "number" && Number.isInteger(record.quantity) && record.quantity > 0
            ? record.quantity
            : (() => {
                throw new DomainError(
                  "INVALID_IMPORTED_TRANSACTION",
                  "items.quantity must be a positive integer",
                  400,
                );
              })(),
      unitValue:
        record.unitValue == null || record.unitValue === ""
          ? null
          : typeof record.unitValue === "number" && Number.isFinite(record.unitValue) && record.unitValue >= 0
            ? record.unitValue
            : (() => {
                throw new DomainError(
                  "INVALID_IMPORTED_TRANSACTION",
                  "items.unitValue must be a non-negative number",
                  400,
                );
              })(),
      currency:
        record.currency == null
          ? null
          : typeof record.currency === "string" && /^[A-Za-z]{3}$/.test(record.currency.trim())
            ? record.currency.trim().toUpperCase()
            : (() => {
                throw new DomainError("INVALID_IMPORTED_TRANSACTION", "items.currency is invalid", 400);
              })(),
      metadata: {},
    };
  });
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
  if (!buyer.email) {
    return { externalId: buyer.externalId, displayName: buyer.displayName, email: null };
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
