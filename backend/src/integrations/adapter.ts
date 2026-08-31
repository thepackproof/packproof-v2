import type { ImportedTransaction } from "../domain/imported-transaction.js";

export type IntegrationAdapterKind = "reference" | "trusted";

export interface IntegrationAdapter {
  readonly adapterKey: string;
  readonly kind: IntegrationAdapterKind;
  fetchPurchase(input: {
    externalTransactionId?: string | null;
  }): Promise<ImportedTransaction>;
}
