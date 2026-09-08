import type { IntakeItem } from './model';
export type FulfillmentScope = 'FULL_ORDER' | 'PARTIAL' | 'MULTI_PARCEL' | 'UNKNOWN';
export interface IntakeObservationDetail { observationId: string; items: IntakeItem[]; physicalFulfillment: boolean | null; paid: boolean | null; fulfillmentScope: FulfillmentScope; orderReference: string | null; reasonCodes: string[]; }
export interface ResolutionDraft { items: Array<{ title: string; quantity: string; variant: string; original?: IntakeItem }>; physicalFulfillment: 'yes' | 'no' | 'unknown'; paid: 'yes' | 'no' | 'unknown'; fulfillmentScope: FulfillmentScope; reason: string; }
export interface IntakeResolution { receiptId: string; items: IntakeItem[]; physicalFulfillment?: boolean; paid?: boolean; fulfillmentScope: FulfillmentScope; reason: string; }
export function resolutionDraft(source: IntakeObservationDetail): ResolutionDraft {
  const answer = (value: boolean | null) => value === true ? 'yes' as const : value === false ? 'no' as const : 'unknown' as const;
  return { items: source.items.map(item => ({ original: item, title: item.title ?? item.description ?? '', quantity: item.quantity == null ? '' : String(item.quantity), variant: item.variant ?? '' })), physicalFulfillment: answer(source.physicalFulfillment), paid: answer(source.paid), fulfillmentScope: source.fulfillmentScope, reason: '' };
}
export function buildIntakeResolution(draft: ResolutionDraft, receiptId: string): IntakeResolution {
  if (!draft.items.length) throw new Error('Add the purchased items before saving this order.');
  const items = draft.items.map((item, index) => {
    if (!item.title.trim()) throw new Error(`Add a description for item ${index + 1}.`);
    if (!/^[1-9]\d*$/.test(item.quantity.trim()) || !Number.isSafeInteger(Number(item.quantity))) throw new Error(`Enter the purchased quantity for item ${index + 1} as a whole number greater than zero.`);
    return { ...item.original, title: item.title.trim(), quantity: Number(item.quantity), variant: item.variant.trim() || null };
  });
  if (!draft.reason.trim()) throw new Error('Explain the correction so the original source and your changes remain clear.');
  return { receiptId, items, fulfillmentScope: draft.fulfillmentScope, reason: draft.reason.trim(), ...(draft.physicalFulfillment === 'unknown' ? {} : { physicalFulfillment: draft.physicalFulfillment === 'yes' }), ...(draft.paid === 'unknown' ? {} : { paid: draft.paid === 'yes' }) };
}
const explanations: Record<string, string> = {
  EXACT_ORDER_ID_REQUIRED: 'The exact store order ID is missing. Reconnect or refresh the original source; an order display number cannot replace it.',
  PURCHASED_ITEMS_REQUIRED: 'The source did not include the purchased items.',
  ITEM_DESCRIPTION_AND_QUANTITY_REQUIRED: 'Add each purchased item’s description and quantity.',
  PHYSICAL_ORDER_REQUIRED: 'This order is marked as nonphysical. Confirm the source before correcting it.',
  FULFILLMENT_TYPE_REQUIRED: 'Confirm whether this order contains physical goods to ship.',
  PAYMENT_PENDING: 'Payment is still pending. Record only once payment is confirmed.',
  PAYMENT_STATE_REQUIRED: 'The source did not say whether the order was paid.',
  ORDER_CANCELLED: 'This order was cancelled. Check its status at the original store.',
  PARCEL_SCOPE_REQUIRES_REVIEW: 'Confirm whether this package contains the full order. Partial or multiple-package orders need their existing allocation workflow.',
  ORDER_SCOPE_CONFLICT: 'The source store does not match this account. Check the connection; these orders cannot be merged here.',
  ORDER_CONTEXT_CHANGED: 'The purchased items changed after preparation. Review the source and explain the correction.',
  ORDER_CONTEXT_REVIEW_REQUIRED: 'Conflicting order details need review before recording can continue.',
  EXISTING_ORDER_CONTEXT_CONFLICT: 'These items differ from the order already saved in PackProof. Check the original order before correcting them.',
};
export function intakeReasonText(code: string): string { return explanations[code] ?? 'The source needs review before this order can be recorded.'; }
