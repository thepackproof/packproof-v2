import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { ImportedTransaction } from "../domain/imported-transaction.js";
import type { IntegrationAdapter } from "./adapter.js";

export const DEMO_MARKETPLACE_ADAPTER_KEY = "demo-marketplace";

export function createDemoMarketplaceAdapter(clock: Clock): IntegrationAdapter {
  return {
    adapterKey: DEMO_MARKETPLACE_ADAPTER_KEY,
    kind: "reference",
    async fetchPurchase(input) {
      const externalTransactionId =
        input.externalTransactionId?.trim() || `DM-${newId("ord").slice("ord_".length)}`;
      const importedAt = clock.now().toISOString();
      const imported: ImportedTransaction = {
        provider: DEMO_MARKETPLACE_ADAPTER_KEY,
        externalTransactionId,
        transactionDate: "2026-08-20",
        itemTitle: "Vintage film camera",
        itemDescription: "Fully tested body with original strap",
        quantity: 1,
        transactionValue: 250.5,
        currency: "USD",
        shipping: {
          carrier: "UPS",
          service: "Ground",
          trackingNumber: "1Z999AA10123456784",
          shipmentDate: "2026-08-21",
        },
        buyer: {
          externalId: "buyer_demo_1",
          displayName: "Alex Buyer",
          email: "alex.buyer@example.com",
        },
        provenance: {
          source: "MARKETPLACE_API",
          sourceRecordId: `demo-order-${externalTransactionId}`,
          importedAt,
        },
      };
      return imported;
    },
  };
}
