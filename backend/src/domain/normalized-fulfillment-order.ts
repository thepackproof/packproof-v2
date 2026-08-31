import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import {
  decideFulfillmentEligibility,
  type FulfillmentEligibility,
  type NormalizedFulfillmentState,
  type NormalizedPaymentState,
  NORMALIZED_FULFILLMENT_STATES,
  NORMALIZED_PAYMENT_STATES,
} from "./fulfillment-eligibility.js";
import type { ImportedTransaction } from "./imported-transaction.js";
import type { ProvenanceSource } from "./provenance.js";
import { requireProvenanceSource } from "./provenance.js";
import type { TransactionItemWrite } from "./transaction-items.js";

export interface NormalizedOrderItem {
  externalItemId: string | null;
  position: number;
  title: string | null;
  description: string | null;
  sku: string | null;
  quantity: number | null;
  unitValue: number | null;
  currency: string | null;
}

export interface NormalizedFulfillmentOrder {
  provider: string;
  externalAccountReference: string;
  externalOrderId: string;
  externalReference: string | null;
  orderedAt: string;
  paymentState: NormalizedPaymentState;
  fulfillmentState: NormalizedFulfillmentState;
  requiresPhysicalFulfillment: boolean;
  cancelled: boolean;
  items: NormalizedOrderItem[];
  transactionValue: number | null;
  currency: string | null;
  buyer: {
    externalId: string | null;
    displayName: string | null;
  } | null;
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  } | null;
  providerUpdatedAt: string | null;
  provenance: {
    source: "STOREFRONT_API" | "MARKETPLACE_API";
    sourceRecordId: string | null;
  };
}

export interface CommerceOrderPage {
  orders: NormalizedFulfillmentOrder[];
  cursor: string | null;
}

const PROVIDER_MAX = 80;
const ACCOUNT_MAX = 120;
const ORDER_ID_MAX = 200;

export function normalizeExternalAccountReference(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError(
      "INVALID_FULFILLMENT_ORDER",
      "externalAccountReference is required",
      400,
    );
  }
  const account = value.trim().toLowerCase();
  if (!account || account.length > ACCOUNT_MAX || !/^[a-z0-9][a-z0-9._-]*$/.test(account)) {
    throw new DomainError(
      "INVALID_FULFILLMENT_ORDER",
      "externalAccountReference is invalid",
      400,
    );
  }
  return account;
}

export function parseNormalizedFulfillmentOrder(input: unknown): NormalizedFulfillmentOrder {
  const record = asRecord(input);
  const provider = normalizeProvider(record.provider);
  const externalAccountReference = normalizeExternalAccountReference(
    record.externalAccountReference,
  );
  const externalOrderId = normalizeRequiredText(record.externalOrderId, "externalOrderId", ORDER_ID_MAX);
  const source = requireProvenanceSource(asRecord(record.provenance).source);
  if (source !== "STOREFRONT_API" && source !== "MARKETPLACE_API") {
    throw new DomainError(
      "INVALID_FULFILLMENT_ORDER",
      "commerce provenance must be STOREFRONT_API or MARKETPLACE_API",
      400,
    );
  }
  const items = parseItems(record.items);
  const shipping = record.shipping == null ? null : parseShipping(record.shipping);
  const buyer = parseBuyer(record.buyer);
  return {
    provider,
    externalAccountReference,
    externalOrderId,
    externalReference: normalizeOptionalText(record.externalReference, "externalReference", ORDER_ID_MAX),
    orderedAt: normalizeIso(record.orderedAt, "orderedAt"),
    paymentState: requireEnum(record.paymentState, NORMALIZED_PAYMENT_STATES, "paymentState"),
    fulfillmentState: requireEnum(
      record.fulfillmentState,
      NORMALIZED_FULFILLMENT_STATES,
      "fulfillmentState",
    ),
    requiresPhysicalFulfillment: record.requiresPhysicalFulfillment === true,
    cancelled: record.cancelled === true,
    items,
    transactionValue: normalizeMoney(record.transactionValue, "transactionValue"),
    currency: normalizeCurrency(record.currency),
    buyer,
    shipping,
    providerUpdatedAt:
      record.providerUpdatedAt == null
        ? null
        : normalizeIso(record.providerUpdatedAt, "providerUpdatedAt"),
    provenance: {
      source,
      sourceRecordId: normalizeOptionalText(
        asRecord(record.provenance).sourceRecordId,
        "provenance.sourceRecordId",
        ORDER_ID_MAX,
      ),
    },
  };
}

export function fulfillmentOrderFingerprint(order: NormalizedFulfillmentOrder): string {
  return sha256Hex(
    canonicalize({
      provider: order.provider,
      externalAccountReference: order.externalAccountReference,
      externalOrderId: order.externalOrderId,
      externalReference: order.externalReference,
      orderedAt: order.orderedAt,
      paymentState: order.paymentState,
      fulfillmentState: order.fulfillmentState,
      requiresPhysicalFulfillment: order.requiresPhysicalFulfillment,
      cancelled: order.cancelled,
      items: order.items,
      transactionValue: order.transactionValue,
      currency: order.currency,
      buyer: order.buyer,
      shipping: order.shipping,
      providerUpdatedAt: order.providerUpdatedAt,
      provenance: order.provenance,
    }),
  );
}

export function eligibilityOf(order: NormalizedFulfillmentOrder): FulfillmentEligibility {
  return decideFulfillmentEligibility(order);
}

export function fulfillmentOrderToImportedTransaction(
  order: NormalizedFulfillmentOrder,
  importedAt: string,
): ImportedTransaction {
  const summary = summarizeOrder(order);
  return {
    provider: order.provider,
    externalTransactionId: order.externalOrderId,
    externalAccountReference: order.externalAccountReference,
    externalReference: order.externalReference ?? order.externalOrderId,
    transactionDate: order.orderedAt.slice(0, 10),
    itemTitle: summary.itemTitle,
    itemDescription: summary.itemDescription,
    quantity: summary.quantity,
    transactionValue: order.transactionValue ?? summary.transactionValue,
    currency: order.currency ?? summary.currency,
    shipping: order.shipping,
    items: order.items,
    buyer: order.buyer
      ? {
          externalId: order.buyer.externalId,
          displayName: order.buyer.displayName,
        }
      : null,
    provenance: {
      source: order.provenance.source,
      sourceRecordId: order.provenance.sourceRecordId,
      importedAt,
    },
  };
}

export function summarizeOrder(order: {
  items: NormalizedOrderItem[];
  transactionValue: number | null;
  currency: string | null;
}): {
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
} {
  return summarizeItems(order.items, order.transactionValue, order.currency);
}

export function summarizeItems(
  items: Array<{
    title?: string | null;
    description?: string | null;
    quantity?: number | null;
    unitValue?: number | null;
    currency?: string | null;
  }>,
  transactionValue?: number | null,
  currency?: string | null,
): {
  itemTitle: string | null;
  itemDescription: string | null;
  quantity: number | null;
  transactionValue: number | null;
  currency: string | null;
} {
  if (items.length === 0) {
    return {
      itemTitle: null,
      itemDescription: null,
      quantity: null,
      transactionValue: transactionValue ?? null,
      currency: currency ?? null,
    };
  }
  const first = items[0];
  const quantity = items.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const computedValue = items.every((item) => item.unitValue != null && item.quantity != null)
    ? items.reduce((sum, item) => sum + (item.unitValue ?? 0) * (item.quantity ?? 0), 0)
    : null;
  return {
    itemTitle: first.title ?? null,
    itemDescription: items.length === 1 ? (first.description ?? null) : `${items.length} line items`,
    quantity: quantity > 0 ? quantity : null,
    transactionValue: transactionValue ?? computedValue,
    currency: currency ?? first.currency ?? null,
  };
}

export function toItemWrites(items: NormalizedOrderItem[]): TransactionItemWrite[] {
  return items.map((item, index) => ({
    externalItemId: item.externalItemId,
    position: item.position || index + 1,
    title: item.title,
    description: item.description,
    sku: item.sku,
    quantity: item.quantity,
    unitValue: item.unitValue,
    currency: item.currency,
    metadata: {},
  }));
}

function parseItems(value: unknown): NormalizedOrderItem[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", "items must be an array", 400);
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const position = record.position == null ? index + 1 : Number(record.position);
    if (!Number.isInteger(position) || position <= 0) {
      throw new DomainError("INVALID_FULFILLMENT_ORDER", "item position is invalid", 400);
    }
    return {
      externalItemId: normalizeOptionalText(record.externalItemId, "items.externalItemId", ORDER_ID_MAX),
      position,
      title: normalizeOptionalText(record.title, "items.title", 200),
      description: normalizeOptionalText(record.description, "items.description", 4000),
      sku: normalizeOptionalText(record.sku, "items.sku", 120),
      quantity: normalizePositiveInt(record.quantity, "items.quantity"),
      unitValue: normalizeMoney(record.unitValue, "items.unitValue"),
      currency: normalizeCurrency(record.currency),
    };
  });
}

function parseShipping(value: unknown): NormalizedFulfillmentOrder["shipping"] {
  const record = asRecord(value);
  const shipping = {
    carrier: normalizeOptionalText(record.carrier, "shipping.carrier", 100),
    service: normalizeOptionalText(record.service, "shipping.service", 100),
    trackingNumber: normalizeOptionalText(record.trackingNumber, "shipping.trackingNumber", 100),
    shipmentDate: normalizeOptionalText(record.shipmentDate, "shipping.shipmentDate", 32),
  };
  if (
    !shipping.carrier &&
    !shipping.service &&
    !shipping.trackingNumber &&
    !shipping.shipmentDate
  ) {
    return null;
  }
  return shipping;
}

function parseBuyer(value: unknown): NormalizedFulfillmentOrder["buyer"] {
  if (value == null) {
    return null;
  }
  const record = asRecord(value);
  const buyer = {
    externalId: normalizeOptionalText(record.externalId, "buyer.externalId", 200),
    displayName: normalizeOptionalText(record.displayName, "buyer.displayName", 200),
  };
  if (!buyer.externalId && !buyer.displayName) {
    return null;
  }
  return buyer;
}

function normalizeProvider(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", "provider is required", 400);
  }
  const provider = value.trim().toLowerCase();
  if (!provider || provider.length > PROVIDER_MAX || !/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", "provider is invalid", 400);
  }
  return provider;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} is invalid`, 400);
  }
  return value as T;
}

function normalizeIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} is required`, 400);
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} is invalid`, 400);
  }
  return date.toISOString();
}

function normalizeRequiredText(value: unknown, field: string, max: number): string {
  const text = normalizeOptionalText(value, field, max);
  if (!text) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} is required`, 400);
  }
  return text;
}

function normalizeOptionalText(value: unknown, field: string, max: number): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} must be a string`, 400);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > max) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} is too long`, 400);
  }
  return trimmed;
}

function normalizePositiveInt(value: unknown, field: string): number | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} must be a positive integer`, 400);
  }
  return value;
}

function normalizeMoney(value: unknown, field: string): number | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", `${field} must be a non-negative number`, 400);
  }
  return value;
}

function normalizeCurrency(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", "currency must be a string", 400);
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new DomainError("INVALID_FULFILLMENT_ORDER", "currency must be a 3-letter code", 400);
  }
  return normalized;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}
