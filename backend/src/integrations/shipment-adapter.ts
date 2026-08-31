import type { IntegrationAdapterKind } from "./adapter.js";
import type { ImportedShipmentEvent } from "../domain/imported-shipment-event.js";

export interface FetchShipmentEventsInput {
  transactionId: string;
  trackingNumber: string | null;
  externalTransactionId: string | null;
  throughEventType?: string | null;
}

export interface ShipmentObservationAdapter {
  readonly adapterKey: string;
  readonly kind: IntegrationAdapterKind;
  fetchShipmentEvents(input: FetchShipmentEventsInput): Promise<ImportedShipmentEvent[]>;
}
