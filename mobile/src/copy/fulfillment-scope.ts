export const REMAINING_SHIPMENT_LABEL = "Remaining shipment";
export const REMAINING_SHIPMENT_EXPLANATION = "Only the listed remaining items are covered; previously shipped items are excluded.";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Display an explicit server scope; never infer coverage from item text or shipment status. */
export function hasRemainingShipmentScope(value: unknown): boolean {
  const source = record(value);
  const snapshot = record(record(source.orderContext).snapshot);
  const imported = record(record(record(source.transaction).metadata).import);
  return source.fulfillmentScope === "REMAINING_SHIPMENT"
    || snapshot.fulfillmentScope === "REMAINING_SHIPMENT"
    || (imported.provider === "shopify" && record(imported.providerIdentifiers).fulfillmentScope === "REMAINING_SHIPMENT");
}
