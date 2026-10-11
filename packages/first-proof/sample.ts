/** Synthetic read-only sample, independent of account data and application services. */
export const sampleChronology: Array<{id:string;occurredAt:string;category:'COMMERCE'|'PROOF'|'SHIPMENT';title:string;description:string;source:string;provider?:string;relatedEntityId:null;eventType:string}> = [
  {id:'sample-order',occurredAt:'2026-09-01T09:41:00Z',category:'COMMERCE',title:'Order added',description:'The order details were connected to this fictional sample.',source:'example',provider:'Example store',relatedEntityId:null,eventType:'ORDER_IMPORTED'},
  {id:'sample-evidence',occurredAt:'2026-09-01T09:44:00Z',category:'PROOF',title:'Illustrative footage added',description:'Stock footage shows a mug and packing material; no seal or label is shown.',source:'sample',relatedEntityId:null,eventType:'EVIDENCE_COMMITTED'},
  {id:'sample-final',occurredAt:'2026-09-01T09:46:00Z',category:'PROOF',title:'Proof finalized',description:'This fictional event illustrates when the evidence record would be finalized. It is not a real finalization.',source:'sample',relatedEntityId:null,eventType:'PROOF_FINALIZED'},
  {id:'sample-scan',occurredAt:'2026-09-02T14:20:00Z',category:'SHIPMENT',title:'Arrived at facility',description:'Illustrative carrier scan. This is not a real shipment.',source:'example',provider:'Example carrier',relatedEntityId:null,eventType:'ARRIVED_AT_FACILITY'},
];
