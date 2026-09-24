import { hasRemainingShipmentScope, REMAINING_SHIPMENT_EXPLANATION, REMAINING_SHIPMENT_LABEL } from "@packproof/copy/fulfillment-scope";

export function RemainingShipmentNotice({ value }: { value: unknown }) {
  if (!hasRemainingShipmentScope(value)) return null;
  return <div className="note" aria-label="Shipment scope"><strong>{REMAINING_SHIPMENT_LABEL}</strong><p>{REMAINING_SHIPMENT_EXPLANATION}</p></div>;
}
