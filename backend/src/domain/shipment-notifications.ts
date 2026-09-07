import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { object } from '../integrations/shippo/client.js';
import { shippoCarrier } from '../integrations/shippo/adapter.js';
import { string, trackingIdentity } from '../integrations/shippo/normalize.js';
import { DomainError } from './errors.js';

/** Durable, rate-coalesced notification only. Event body/status is never evidence. */
export async function queueShippoNotification(db:Database,clock:Clock,raw:Buffer) {
  if(raw.length>256*1024)throw new DomainError('WEBHOOK_TOO_LARGE','Notification exceeds the accepted size',413);
  let event:Record<string,unknown>|null=null;
  try{event=object(JSON.parse(raw.toString('utf8')));}catch{throw new DomainError('WEBHOOK_INVALID','Expected a tracking notification',400);}
  const data=object(event?.data),tracking=trackingIdentity(string(data?.tracking_number));
  // Acknowledge irrelevant/unknown notifications identically. Do not reveal order existence.
  if(event?.event!=='track_updated'||!data||!tracking||tracking.length>128||typeof event.test!=='boolean')return;
  const rows=(await db.query<{transaction_id:string;connection_id:string;carrier:string|null;provider_mode:string|null}>(`SELECT j.transaction_id,c.id AS connection_id,s.carrier,j.provider_mode FROM capture_shipment_jobs j JOIN transaction_shipment_connections b ON b.transaction_id=j.transaction_id JOIN integration_connections c ON c.id=b.connection_id JOIN transaction_shipping s ON s.transaction_id=j.transaction_id WHERE c.adapter_key='shippo-tracker' AND c.status='ACTIVE' AND s.tracking_number=$1 AND j.next_run_at IS NOT NULL LIMIT 100`,[tracking])).rows;
  const bucket=Math.floor(clock.now().getTime()/300000).toString(),hash=sha256Hex(raw);
  for(const row of rows){
    if(row.provider_mode && event.test!==(row.provider_mode==='test'))continue;
    try{if(string(data.carrier).toLowerCase()!==shippoCarrier(tracking,row.carrier))continue;}catch{continue;}
    await db.transaction(async tx=>{
      const inserted=await tx.query(`INSERT INTO shipment_notification_inbox(id,transaction_id,connection_id,payload_sha256,notification_bucket,received_at,state) VALUES($1,$2,$3,$4,$5,$6,'QUEUED') ON CONFLICT(transaction_id,notification_bucket) DO NOTHING RETURNING id`,[newId('sni'),row.transaction_id,row.connection_id,hash,bucket,clock.now().toISOString()]);
      if(inserted.rowCount)await tx.query(`UPDATE capture_shipment_jobs SET next_run_at=LEAST(next_run_at,$2) WHERE transaction_id=$1 AND next_run_at IS NOT NULL AND state<>'FAILED'`,[row.transaction_id,clock.now().toISOString()]);
    });
  }
}
