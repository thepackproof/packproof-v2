import rules from './typed-source-rules.json' with {type:'json'};
/** Opt-in operational source contracts. These are bounded transport profiles,
 * not claims that a vendor or customer feed has been qualified. */
export const TYPED_SOURCE_SCHEMA='packproof.typed-source-batch/v1' as const;
export const SOURCE_CONTRACT_VERSION='packproof.source-contracts/v1' as const;
export type SourceProfileId='packproof.order-lines/v1'|'packproof.shipment-handling-units/v1'|'packproof.operational-observations/v1';
export type SourceEntityType='order'|'order_line'|'shipment'|'handling_unit'|'load'|'stop'|'return'|'product'|'serialized_unit'|'tracking';
export type SourceProperty='orderedQuantity'|'allocatedQuantity'|'canceledQuantity'|'backorderedQuantity'|'reportedPickedQuantity'|'reportedPackedQuantity'|'reportedLoadedQuantity'|'reportedReceivedQuantity'|'reportedReturnedQuantity'|'description'|'status'|'serial'|'trackingNumber';
export type SourceRelationshipType='has_line'|'fulfills'|'allocated_to'|'contains'|'loaded_on'|'delivered_at'|'return_of'|'tracks'|'same_as';
export const SOURCE_PROFILES=rules.profiles as readonly {id:SourceProfileId;grain:string;requiredReferences:readonly SourceEntityType[];allowedProperties:readonly SourceProperty[];description:string}[];
export const TYPED_SOURCE_LIMITS=rules.limits;
export const SOURCE_ENTITY_TYPES=rules.entityTypes as readonly SourceEntityType[];
export const SOURCE_QUANTITY_PROPERTIES=rules.quantityProperties as readonly SourceProperty[];
export const SOURCE_PROPERTIES=rules.properties as readonly SourceProperty[];
export const SOURCE_RELATIONSHIP_TYPES=rules.relationshipTypes as readonly SourceRelationshipType[];
export type SourceCsvField='sourceEventId'|'sourceRevision'|'observationKind'|'supersedesRevision'|'orderId'|'orderLineId'|'shipmentId'|'handlingUnitId'|'loadId'|'stopId'|'returnId'|'productId'|'serialId'|'trackingId'|'property'|'amount'|'unit'|'value'|'occurredAt'|'sourceAsOf'|'timeQuality'|'originSystem'|'copiedFromSource';
export const SOURCE_CSV_FIELDS=rules.csvFields as readonly SourceCsvField[];
export {rules as TYPED_SOURCE_RULES};
