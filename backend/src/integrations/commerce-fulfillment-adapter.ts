import type { IntegrationConnectionRow } from "../domain/integration-connections.js";
import type {
  CommerceOrderPage,
  NormalizedFulfillmentOrder,
} from "../domain/normalized-fulfillment-order.js";
import type { IntegrationAdapterKind } from "./adapter.js";
import type { IntegrationCredentials } from "./credentials.js";

export interface CommerceFulfillmentAdapter {
  readonly adapterKey: string;
  readonly kind: IntegrationAdapterKind;
  readonly provider: string;
  readonly displayName: string;
  listFulfillmentOrders(input: {
    connection: IntegrationConnectionRow;
    credentials?: IntegrationCredentials | null;
    cursor?: string | null;
  }): Promise<CommerceOrderPage>;
  fetchFulfillmentOrder?(input: {
    connection: IntegrationConnectionRow;
    externalOrderId: string;
    credentials?: IntegrationCredentials | null;
  }): Promise<NormalizedFulfillmentOrder>;
}
