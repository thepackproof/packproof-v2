import type { Database } from '../db/database.js';
import type { DisclosureContext } from './disclosure.js';
import { listShipmentEventsForProof } from './shipment-events.js';

type SafeChronology = {id:string;occurredAt:string;title:string;category:'PROOF'|'SHIPMENT';source:string;provider?:string;eventType:string;description:null;relatedEntityId:null};
/** Explicit, scoped fact projection. Never serialize owner audit payloads or contact/label data. */
export async function disclosedRecord(db:Database,ctx:DisclosureContext) {
  const chronology:SafeChronology[]=[];
  const core=(await db.query<{id:string;event_type:string;created_at:string|Date}>("SELECT id,event_type,created_at FROM audit_events WHERE proof_id=$1 AND event_type IN ('PROOF_CREATED','PROOF_FINALIZED') ORDER BY created_at,id",[ctx.proofId])).rows;
  if(ctx.fields.includes('status')) for(const e of core) chronology.push({id:e.id,occurredAt:new Date(e.created_at).toISOString(),title:e.event_type==='PROOF_FINALIZED'?'Proof locked':'Proof created',category:'PROOF',source:'PACKPROOF',eventType:e.event_type,description:null,relatedEntityId:null});
  if(ctx.fields.includes('evidence') && ctx.media.length) {
    const ids=ctx.media.map(m=>m.evidenceId);
    const media=(await db.query<{id:string;committed_at:string|Date}>(`SELECT id,committed_at FROM evidence WHERE proof_id=$1 AND id=ANY($2::text[]) AND validation_status='COMMITTED'
      UNION ALL SELECT e.id,e.committed_at FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 AND e.id=ANY($2::text[]) AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL`,[ctx.proofId,ids])).rows;
    for(const e of media) chronology.push({id:e.id,occurredAt:new Date(e.committed_at).toISOString(),title:'Recording saved',category:'PROOF',source:'PACKPROOF',eventType:'EVIDENCE_COMMITTED',description:null,relatedEntityId:null});
  }
  if(ctx.fields.includes('statements')) {
    const declarations=(await db.query<{id:string;created_at:string|Date;related_evidence_id:string|null}>("SELECT id,created_at,related_evidence_id FROM attestations WHERE proof_id=$1 ORDER BY created_at,id",[ctx.proofId])).rows;
    for(const a of declarations) if(!a.related_evidence_id||ctx.media.some(m=>m.evidenceId===a.related_evidence_id)) chronology.push({id:a.id,occurredAt:new Date(a.created_at).toISOString(),title:'Declaration confirmed',category:'PROOF',source:'PARTICIPANT_SUPPLIED',eventType:'ATTESTATION_COMMITTED',description:null,relatedEntityId:null});
  }
  let recordTracking:null|{carrier:string|null;status:string|null;lastUpdatedAt:string|null;source:string;syncState:string;events:Array<{id:string;eventType:string;occurredAt:string;source:string;provider:string}>}=null;
  if(ctx.fields.includes('shipping')) {
    const events=await listShipmentEventsForProof(db,ctx.proofId);
    const carrierEvents=events.filter(e=>e.source==='SHIPPING_PROVIDER_API');
    const latest=carrierEvents.at(-1);
    const data=(await db.query<{carrier:string|null;tracking_number:string|null;job_state:string|null;last_error_code:string|null;last_succeeded_at:string|Date|null}>(`SELECT s.carrier,s.tracking_number,j.state AS job_state,ss.last_error_code,ss.last_succeeded_at FROM proofs p
      LEFT JOIN transaction_shipping s ON s.transaction_id=p.transaction_id
      LEFT JOIN capture_shipment_jobs j ON j.transaction_id=p.transaction_id
      LEFT JOIN shipment_sync_states ss ON ss.transaction_id=p.transaction_id WHERE p.id=$1`,[ctx.proofId])).rows[0];
    const syncState=!data?.tracking_number?'NO_LABEL'
      : data.job_state==='WAITING_FOR_CONNECTION'||data.job_state==='FAILED'?'SERVICE_UNAVAILABLE'
      : data.job_state==='RETRY'||data.last_error_code?'SYNC_DELAYED'
      : data.job_state==='QUEUED'?'SYNC_PENDING'
      : latest?'UP_TO_DATE':'AWAITING_CARRIER_SCAN';
    recordTracking={carrier:data?.carrier??null,status:latest?.eventType??null,lastUpdatedAt:data?.last_succeeded_at?new Date(data.last_succeeded_at).toISOString():latest?.observedAt??null,
      source:latest?'SHIPPING_PROVIDER_API':'UNKNOWN',syncState,
      events:events.map(e=>({id:e.id,eventType:e.eventType,occurredAt:e.occurredAt,source:e.source,provider:e.provider}))};
    for(const e of events) chronology.push({id:e.id,occurredAt:e.occurredAt,title:shipmentTitle(e.eventType),category:'SHIPMENT',source:e.source,provider:e.provider,eventType:e.eventType,description:null,relatedEntityId:null});
  }
  chronology.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
  return {chronology,recordTracking};
}
function shipmentTitle(type:string):string {
  return ({LABEL_CREATED:'Shipping label created',CARRIER_ACCEPTED:'Carrier accepted shipment',IN_TRANSIT:'Shipment in transit',OUT_FOR_DELIVERY:'Out for delivery',DELIVERED:'Delivery reported',EXCEPTION:'Shipment exception',WEIGHT_RECORDED:'Shipment weight reported'} as Record<string,string>)[type]??'Shipment update';
}
