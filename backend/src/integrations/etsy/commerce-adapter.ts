import type { IntegrationConnectionRow } from "../../domain/integration-connections.js";
import { DomainError } from "../../domain/errors.js";
import { IntegrationError } from "../../domain/integration-errors.js";
import type { CommerceFulfillmentAdapter } from "../commerce-fulfillment-adapter.js";
import type { IntegrationCredentials } from "../credentials.js";
import type { EtsyClient } from "./types.js";
import { normalizeEtsyReceipt } from "./normalize.js";

export type EtsyAccessTokenRunner = <T>(
  connection: IntegrationConnectionRow,
  operation: (accessToken: string) => Promise<T>,
) => Promise<T>;

interface EtsyCursor {
  version: 1;
  shopId: string;
  since: string | null;
  until: string | null;
  phase: "pending" | "changed";
  offset: number;
}

/** Read-only receipt intake over the shared PostgreSQL lease/checkpoint worker. */
export function createEtsyCommerceAdapter(client: EtsyClient, withAccessToken: EtsyAccessTokenRunner): CommerceFulfillmentAdapter {
  return {
    adapterKey: "etsy",
    provider: "etsy",
    kind: "trusted",
    displayName: "Etsy",
    preferredPollIntervalMs: 5 * 60_000,
    reconciliationIntervalMs: 60 * 60_000,
    async listFulfillmentOrders(input) {
      const { shopId, shopUserId } = accountIdentity(input.connection, input.credentials);
      const context = { shopId, since: input.updatedSince ?? null, until: input.updatedUntil ?? null };
      const pageCursor = input.cursor ? decodeCursor(input.cursor, context) : {
        ...context, version: 1 as const, phase: input.fullReconciliation ? "pending" as const : "changed" as const, offset: 0,
      };
      await input.onProgress?.();
      const page = await withAccessToken(input.connection, (accessToken) => client.listReceipts({
        accessToken, shopId, limit: 100, offset: pageCursor.offset,
        // Pending backlog has no age cutoff: long lead-time handmade orders matter.
        ...(pageCursor.phase === "pending" ? { wasPaid: true, wasShipped: false } : { minLastModified: input.updatedSince }),
        maxLastModified: input.updatedUntil,
      }));
      await input.onProgress?.();
      if (!Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== pageCursor.offset ||
        page.receipts.length > 100 || (!page.receipts.length && page.offset < page.total)) {
        throw new IntegrationError("PROVIDER_RESPONSE_INVALID", "Etsy returned an incomplete receipt page", 502, true);
      }
      const nextOffset = pageCursor.offset + page.receipts.length;
      let cursor: string | null;
      if (nextOffset < page.total) {
        if (nextOffset > 100_000) throw invalidCursor();
        cursor = encodeCursor({ ...pageCursor, offset: nextOffset });
      } else {
        // Changed receipts include all statuses, so shipping/cancellation removes an
        // existing order from the packing queue without changing its Proof history.
        cursor = pageCursor.phase === "pending" ? encodeCursor({ ...pageCursor, phase: "changed", offset: 0 }) : null;
      }
      return { orders: page.receipts.map(receipt => normalizeEtsyReceipt(receipt, { shopId, shopUserId })), cursor };
    },
    async fetchFulfillmentOrder(input) {
      const { shopId, shopUserId } = accountIdentity(input.connection, input.credentials);
      if (!/^[1-9]\d*$/.test(input.externalOrderId)) throw new DomainError("INVALID_EXTERNAL_ORDER_ID", "Choose a valid Etsy receipt", 400);
      const receipt = await withAccessToken(input.connection, accessToken => client.getReceipt({ accessToken, shopId, receiptId: input.externalOrderId }));
      if (receipt.receipt_id !== input.externalOrderId) throw new DomainError("INTEGRATION_TRUST_BOUNDARY", "Etsy returned another receipt", 403);
      return normalizeEtsyReceipt(receipt, { shopId, shopUserId });
    },
  };
}

function accountIdentity(connection: IntegrationConnectionRow, credentials?: IntegrationCredentials | null) {
  const shopId = connection.external_account_reference ?? "";
  const shopUserId = credentials?.material.etsyUserId ?? "";
  if (!/^[1-9]\d*$/.test(shopId) || !/^[1-9]\d*$/.test(shopUserId) || credentials?.material.etsyShopId !== shopId) {
    throw new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect Etsy to verify the shop identity", 409);
  }
  return { shopId, shopUserId };
}
function encodeCursor(cursor: EtsyCursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decodeCursor(value: string, context: Pick<EtsyCursor, "shopId" | "since" | "until">): EtsyCursor {
  try {
    if (value.length > 2000 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw invalidCursor();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as EtsyCursor;
    if (cursor.version !== 1 || cursor.shopId !== context.shopId || cursor.since !== context.since || cursor.until !== context.until ||
      !["pending", "changed"].includes(cursor.phase) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 100_000) throw invalidCursor();
    return cursor;
  } catch { throw invalidCursor(); }
}
function invalidCursor() { return new IntegrationError("PROVIDER_CURSOR_INVALID", "The Etsy receipt page checkpoint is invalid", 502, false); }
