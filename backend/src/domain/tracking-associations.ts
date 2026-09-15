import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ShippingRow } from './types.js';
import { requireParticipant, loadProof } from './proof-access.js';
import { DomainError } from './errors.js';
import { appendAudit } from './audit.js';
import { newId } from '../ids.js';

export function parseTrackingInput(input: unknown, carrierInput: unknown) {
  if(typeof input!=='string'||input.length>2048)throw new DomainError('INVALID_TRACKING','Paste a tracking number or carrier tracking link.',400);
  let number=input.trim(),carrier=typeof carrierInput==='string'?carrierInput.toLowerCase().trim():'';
  let source='PARTICIPANT_SUPPLIED';
  if(/^https?:\/\//i.test(number)){
    let url:URL;try{url=new URL(number);}catch{throw new DomainError('INVALID_TRACKING','That tracking link could not be read.',400);}
    const host=url.hostname.toLowerCase();
    const providers=[['usps.com','usps',['tLabels','tRef']],['ups.com','ups',['tracknum','trackNums']],['fedex.com','fedex',['trknbr','trackingnumber']],['dhl.com','dhl_express',['tracking-id','trackingNumber']],['dhl.de','dhl_germany',['piececode']]] as const;
    const found=providers.find(([domain])=>host===domain||host.endsWith('.'+domain));
    if(!found)throw new DomainError('UNSUPPORTED_TRACKING_LINK','Paste the tracking number and choose its carrier.',400);
    carrier=found[1];number=found[2].map(key=>url.searchParams.get(key)).find(Boolean)||'';source='CARRIER_LINK';
  }
  number=number.replace(/[\s-]/g,'').toUpperCase();
  if(!/^[A-Z0-9]{8,40}$/.test(number))throw new DomainError('INVALID_TRACKING','Enter a complete tracking number (letters and numbers).',400);
  if(!carrier){if(/^1Z[A-Z0-9]{16}$/.test(number))carrier='ups';else if(/^(9\d{19,21}|[A-Z]{2}\d{9}US)$/.test(number))carrier='usps';}
  if(!['usps','ups','fedex','dhl_express','dhl_germany'].includes(carrier))throw new DomainError('SHIPMENT_CARRIER_REQUIRED','Choose the carrier for this tracking number.',400);
  return {trackingNumber:number,carrier,source};
}

export async function trackingAssociation(db:Database,transactionId:string){
  return (await db.query<{id:string;proof_id:string;transaction_id:string;tracking_number:string;carrier:string;source:string;actor_user_id:string;created_at:Date|string}>('SELECT * FROM proof_tracking_associations WHERE transaction_id=$1',[transactionId])).rows[0]??null;
}
export async function liveShippingIdentity(db:Database,transactionId:string,frozen:ShippingRow|null):Promise<ShippingRow|null>{
  const association=await trackingAssociation(db,transactionId);
  return association?{id:frozen?.id??association.id,transaction_id:transactionId,carrier:association.carrier,service:frozen?.service??null,tracking_number:association.tracking_number,shipment_date:frozen?.shipment_date??null,created_at:association.created_at,updated_at:association.created_at}:frozen;
}
export async function attachTracking(db:Database,clock:Clock,user:string,proofId:string,input:{value?:unknown;carrier?:unknown}){
  const parsed=parseTrackingInput(input.value,input.carrier);
  return db.transaction(async tx=>{
    await requireParticipant(tx,proofId,user,'SELLER');
    const proof=await loadProof(tx,proofId);
    await tx.query('SELECT id FROM transactions WHERE id=$1 FOR UPDATE',[proof.transaction_id]);
    await loadProof(tx,proofId,true);
    const frozen=(await tx.query<ShippingRow>('SELECT * FROM transaction_shipping WHERE transaction_id=$1',[proof.transaction_id])).rows[0]??null;
    const existing=await trackingAssociation(tx,proof.transaction_id);
    const current=existing?.tracking_number||frozen?.tracking_number;
    if(current&&current.replace(/[\s-]/g,'').toUpperCase()!==parsed.trackingNumber)throw new DomainError('TRACKING_CONFLICT',`This Proof already has tracking ${current}. Keep that association or review the shipping correction; a different number cannot silently replace it.`,409);
    const currentCarrier=(existing?.carrier||frozen?.carrier||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    if(current&&currentCarrier&&currentCarrier!==parsed.carrier.replace(/[^a-z0-9]/g,''))throw new DomainError('TRACKING_CONFLICT','The selected carrier differs from the saved shipment. Review the existing association before adding a different carrier.',409);
    const now=clock.now().toISOString();
    if(!existing){
      const id=newId('tracking');
      await tx.query('INSERT INTO shipment_identity_registry(id,transaction_id) VALUES($1,$2)',[id,proof.transaction_id]);
      await tx.query('INSERT INTO proof_tracking_associations(id,proof_id,transaction_id,tracking_number,carrier,source,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,proofId,proof.transaction_id,parsed.trackingNumber,parsed.carrier,parsed.source,user,now]);
      await appendAudit(tx,{proofId,actorUserId:user,eventType:'TRACKING_ASSOCIATED',eventData:{associationId:id,...parsed,packingRecordUnchanged:true,observedInRecording:false},at:clock.now()});
    }
    await tx.query(`INSERT INTO capture_shipment_jobs(transaction_id,actor_user_id,state,next_run_at,updated_at) VALUES($1,$2,'QUEUED',$3,$3)
      ON CONFLICT(transaction_id) DO UPDATE SET state='QUEUED',attempts=0,next_run_at=$3,last_error_code=NULL,updated_at=$3
      WHERE capture_shipment_jobs.lease_until IS NULL OR capture_shipment_jobs.lease_until<=$3`,[proof.transaction_id,user,now]);
    return {trackingNumber:existing?.tracking_number??parsed.trackingNumber,carrier:existing?.carrier??parsed.carrier,source:existing?.source??parsed.source,state:'QUEUED'};
  });
}
