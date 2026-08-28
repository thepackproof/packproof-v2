import { DomainError } from "./errors.js";
import { asRequiredIso, type ShippingRow, type TransactionRow } from "./types.js";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const REFERENCE_MAX = 200;
const SHORT_TEXT_MAX = 100;

export interface ShippingView {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  shipmentDate: string | null;
}

export interface TransactionView {
  transactionId: string;
  externalReference: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: unknown;
  shipping: ShippingView | null;
  proofId: string | null;
  proofStatus: string | null;
  sellerUserId: string;
  buyerUserId: string | null;
}

export interface TransactionCreateInput {
  externalReference: string | null;
  transactionDate: string | null;
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
  metadata: unknown;
  shipping: ShippingWrite | null;
}

export interface TransactionPatchInput {
  externalReference?: string | null;
  transactionDate?: string | null;
  itemTitle?: string | null;
  itemDescription?: string | null;
  quantity?: number | null;
  transactionValue?: number | null;
  currency?: string | null;
}

export interface ShippingWrite {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  shipmentDate: string | null;
}

export type ShippingPatchInput = Partial<ShippingWrite>;

export function emptyShipping(): ShippingView {
  return {
    carrier: null,
    service: null,
    trackingNumber: null,
    shipmentDate: null,
  };
}

export function toShippingView(row: ShippingRow | null | undefined): ShippingView | null {
  if (!row) {
    return null;
  }
  return {
    carrier: row.carrier,
    service: row.service,
    trackingNumber: row.tracking_number,
    shipmentDate: row.shipment_date,
  };
}

export function shippingForManifest(row: ShippingRow | null | undefined): ShippingView {
  return toShippingView(row) ?? emptyShipping();
}

export function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n;
}

export function toTransactionView(
  row: TransactionRow,
  shipping: ShippingRow | null | undefined,
  extras: {
    proofId: string | null;
    proofStatus: string | null;
    buyerUserId: string | null;
  },
): TransactionView {
  return {
    transactionId: row.id,
    externalReference: row.external_reference,
    transactionDate: row.transaction_date,
    itemTitle: row.item_title,
    itemDescription: row.item_description,
    quantity: asNullableNumber(row.quantity),
    transactionValue: asNullableNumber(row.transaction_value),
    currency: row.currency,
    createdBy: row.created_by,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
    metadata: row.transaction_metadata ?? {},
    shipping: toShippingView(shipping),
    proofId: extras.proofId,
    proofStatus: extras.proofStatus,
    sellerUserId: row.created_by,
    buyerUserId: extras.buyerUserId,
  };
}

export function parseTransactionCreate(body: unknown): TransactionCreateInput {
  const record = asRecord(body);
  const shippingRecord = hasOwn(record, "shipping") ? record.shipping : undefined;
  return {
    externalReference: normalizeOptionalString(
      record.externalReference,
      "externalReference",
      REFERENCE_MAX,
    ),
    transactionDate: normalizeDateOnly(record.transactionDate, "transactionDate"),
    itemTitle: normalizeOptionalString(record.itemTitle, "itemTitle", TITLE_MAX),
    itemDescription: normalizeOptionalString(
      record.itemDescription,
      "itemDescription",
      DESCRIPTION_MAX,
    ),
    quantity: normalizeQuantity(record.quantity),
    transactionValue: normalizeTransactionValue(record.transactionValue),
    currency: normalizeCurrency(record.currency),
    metadata: record.metadata ?? {},
    shipping: shippingRecord == null ? null : parseShippingWrite(shippingRecord),
  };
}

export function parseTransactionPatch(body: unknown): TransactionPatchInput {
  const record = asRecord(body);
  const patch: TransactionPatchInput = {};
  if (hasOwn(record, "externalReference")) {
    patch.externalReference = normalizeOptionalString(
      record.externalReference,
      "externalReference",
      REFERENCE_MAX,
    );
  }
  if (hasOwn(record, "transactionDate")) {
    patch.transactionDate = normalizeDateOnly(record.transactionDate, "transactionDate");
  }
  if (hasOwn(record, "itemTitle")) {
    patch.itemTitle = normalizeOptionalString(record.itemTitle, "itemTitle", TITLE_MAX);
  }
  if (hasOwn(record, "itemDescription")) {
    patch.itemDescription = normalizeOptionalString(
      record.itemDescription,
      "itemDescription",
      DESCRIPTION_MAX,
    );
  }
  if (hasOwn(record, "quantity")) {
    patch.quantity = normalizeQuantity(record.quantity);
  }
  if (hasOwn(record, "transactionValue")) {
    patch.transactionValue = normalizeTransactionValue(record.transactionValue);
  }
  if (hasOwn(record, "currency")) {
    patch.currency = normalizeCurrency(record.currency);
  }
  return patch;
}

export function parseShippingPatch(body: unknown): ShippingPatchInput {
  const record = asRecord(body);
  const patch: ShippingPatchInput = {};
  if (hasOwn(record, "carrier")) {
    patch.carrier = normalizeOptionalString(
      record.carrier,
      "carrier",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    );
  }
  if (hasOwn(record, "service")) {
    patch.service = normalizeOptionalString(
      record.service,
      "service",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    );
  }
  if (hasOwn(record, "trackingNumber")) {
    patch.trackingNumber = normalizeOptionalString(
      record.trackingNumber,
      "trackingNumber",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    );
  }
  if (hasOwn(record, "shipmentDate")) {
    patch.shipmentDate = normalizeDateOnly(
      record.shipmentDate,
      "shipmentDate",
      "INVALID_SHIPPING_DETAILS",
    );
  }
  return patch;
}

export function parseShippingWrite(body: unknown): ShippingWrite {
  const record = asRecord(body);
  return {
    carrier: normalizeOptionalString(
      record.carrier,
      "carrier",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    ),
    service: normalizeOptionalString(
      record.service,
      "service",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    ),
    trackingNumber: normalizeOptionalString(
      record.trackingNumber,
      "trackingNumber",
      SHORT_TEXT_MAX,
      "INVALID_SHIPPING_DETAILS",
    ),
    shipmentDate: normalizeDateOnly(
      record.shipmentDate,
      "shipmentDate",
      "INVALID_SHIPPING_DETAILS",
    ),
  };
}

export function shippingWriteHasValues(shipping: ShippingWrite): boolean {
  return (
    shipping.carrier != null ||
    shipping.service != null ||
    shipping.trackingNumber != null ||
    shipping.shipmentDate != null
  );
}

export function changedEntries(
  before: object,
  after: object,
): Record<string, { from: unknown; to: unknown }> {
  const previous = before as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next)) {
    const fromValue = previous[key] ?? null;
    const toValue = next[key] ?? null;
    if (!Object.is(fromValue, toValue)) {
      changed[key] = { from: fromValue, to: toValue };
    }
  }
  return changed;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function invalid(field: string, message: string, code = "INVALID_TRANSACTION_DETAILS"): never {
  throw new DomainError(code, `${field}: ${message}`, 400);
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  code = "INVALID_TRANSACTION_DETAILS",
): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    invalid(field, "must be a string", code);
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > maxLength) {
    invalid(field, `must be at most ${maxLength} characters`, code);
  }
  return normalized;
}

function normalizeDateOnly(
  value: unknown,
  field: string,
  code = "INVALID_TRANSACTION_DETAILS",
): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    invalid(field, "must be a date string", code);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const datePart = trimmed.includes("T") ? trimmed.slice(0, 10) : trimmed;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(datePart)) {
    invalid(field, "must be YYYY-MM-DD", code);
  }
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(5, 7));
  const day = Number(datePart.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    invalid(field, "must be a valid calendar date", code);
  }
  return datePart;
}

function normalizeQuantity(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid("quantity", "must be a positive integer");
  }
  return value;
}

function normalizeTransactionValue(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid("transactionValue", "must be a non-negative number");
  }
  return value;
}

function normalizeCurrency(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    invalid("currency", "must be a string");
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (!/^[A-Z]{3}$/.test(normalized)) {
    invalid("currency", "must be a 3-letter currency code");
  }
  return normalized;
}
