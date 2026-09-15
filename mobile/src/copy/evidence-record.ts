/** Presentation facts only. A sealed packing record says nothing about delivery or item authenticity. */
export function proofReference(id: string, order?: string | null): string {
  return order?.trim() ? `Order ${order.trim()}` : `PP · ${id.replace(/^proof_/, '').slice(-8).toUpperCase()}`;
}

export function packingRecordLabel(status: string): string {
  return status === 'FINALIZED' ? 'Packing record sealed' : status === 'EVIDENCE_COMMITTED' ? 'Recording saved · seal pending' : 'Packing record in progress';
}

export function shipmentRecordLabel(tracking?: string | null, state?: string | null): string {
  return state?.trim() ? state.replaceAll('_', ' ').toLowerCase() : tracking ? 'Number saved · awaiting carrier' : 'Tracking not connected';
}

// Unknown future events stay in detailed history until they have a reviewed customer-facing meaning.
export const RECORD_HIGHLIGHTS = new Set([
  'PROOF_CREATED', 'TRANSACTION_IMPORTED', 'SHIPPING_DETAILS_IMPORTED', 'SHIPPING_DETAILS_UPDATED',
  'TRACKING_ASSOCIATED', 'PARTICIPANT_INVITED', 'PARTICIPANT_JOINED', 'INVITATION_ACCEPTED',
  'EVIDENCE_COMMITTED', 'ATTESTATION_COMMITTED', 'SELLER_PACKING_ATTESTED', 'PROOF_FINALIZED',
  'LIFECYCLE_STAGE_FINALIZED', 'LIFECYCLE_EVIDENCE_COMMITTED', 'RECEIPT_RECORDED',
  'RECEIVER_INVITED', 'RECEIVER_JOINED', 'LIFECYCLE_STAGE_CREATED', 'RETURN_PACKING_FINALIZED', 'RETURN_RECEIPT_FINALIZED', 'RECEIPT_FINALIZED', 'RETURN_PACKING_RECORDED', 'RETURN_RECEIPT_RECORDED', 'ACCESS_LINK_CREATED',
  'PROOF_ACCESSED', 'PROOF_VIEWED_VIA_ACCESS_LINK',
]);
export function isRecordHighlight(event: { eventType: string; category?: string }): boolean {
  return event.category === 'SHIPMENT' || RECORD_HIGHLIGHTS.has(event.eventType.toUpperCase());
}
