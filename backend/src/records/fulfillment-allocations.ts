import {evaluateQuantities, type Quantity} from './quantities.js';
import {sourceReferenceKey, type TypedSourceObservation, type TypedSourceReference} from './source-contracts.js';

export function shipmentEdgesForLine(observation: TypedSourceObservation, line: TypedSourceReference) {
 const key = sourceReferenceKey(line);
 return observation.relationships.filter(edge =>
  edge.type === 'fulfills' && edge.from.type === 'shipment' &&
  edge.to.type === 'order_line' && sourceReferenceKey(edge.to) === key);
}

/** An unpartitioned line amount belongs to a single related shipment only.
 * For a split, every edge must carry its own amount and reconcile to the line. */
export function resolvedLineAllocations(
 edges: ReturnType<typeof shipmentEdgesForLine>, lineQuantity: Quantity,
): Array<{shipment: TypedSourceReference; quantity: Quantity}> {
 if (edges.length === 1 && edges[0].quantity === null) {
  return [{shipment: edges[0].from, quantity: lineQuantity}];
 }
 const allocations = edges.flatMap(edge => edge.quantity ? [{shipment: edge.from, quantity: edge.quantity}] : []);
 if (!allocations.length || allocations.length !== edges.length ||
     evaluateQuantities(lineQuantity, allocations.map(allocation => allocation.quantity)).outcome !== 'within_tolerance') {
  return [];
 }
 return allocations;
}
