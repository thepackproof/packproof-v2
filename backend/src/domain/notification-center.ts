import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from './errors.js';
import { requireActiveAccount } from './account-access.js';
import { requireParticipant } from './proof-access.js';

export const notificationCategories=['uploads','evidence','participants','shipments','returns'] as const;
export type NotificationCategory=typeof notificationCategories[number];
export const defaultNotificationPreferences={enabled:true,uploads:true,evidence:true,participants:true,shipments:true,returns:true};
export function proofUpdateMeaning(type:string):{category:NotificationCategory;title:string}|null{
  const labels:Record<string,[NotificationCategory,string]>={
    EVIDENCE_COMMITTED:['uploads','Recording saved'], PROOF_FINALIZED:['evidence','Packing record sealed'],
    ATTESTATION_COMMITTED:['evidence','Attestation recorded'], SELLER_PACKING_ATTESTED:['evidence','Attestation recorded'],
    EVIDENCE_UPLOAD_FAILED:['uploads','Recording needs attention'],
    PARTICIPANT_INVITED:['participants','Participant invited'],PARTICIPANT_JOINED:['participants','Participant joined'],
    INVITATION_ACCEPTED:['participants','Invitation accepted'],TRACKING_ASSOCIATED:['shipments','Tracking number added to the Proof'],
    LIFECYCLE_EVIDENCE_COMMITTED:['returns','New receipt or return evidence'],LIFECYCLE_STAGE_FINALIZED:['returns','Receipt or return record sealed'],
    LABEL_CREATED:['shipments','Carrier reports label created'],CARRIER_ACCEPTED:['shipments','Carrier accepted the package'],
    IN_TRANSIT:['shipments','Package in transit'],ARRIVED_AT_FACILITY:['shipments','Package arrived at a carrier facility'],
    DEPARTED_FACILITY:['shipments','Package left a carrier facility'],OUT_FOR_DELIVERY:['shipments','Package out for delivery'],
    DELIVERED:['shipments','Carrier reported delivery'],DELIVERY_EXCEPTION:['shipments','Shipment needs attention'],
    RETURN_TO_SENDER:['returns','Package returning to sender'],RETURN_IN_TRANSIT:['returns','Return in transit'],RETURN_DELIVERED:['returns','Carrier reported return delivery'],
  };const entry=labels[type];return entry?{category:entry[0],title:entry[1]}:null;
}
export async function notificationPreferences(db:Database,user:string){
  await requireActiveAccount(db,user);
  const row=(await db.query<typeof defaultNotificationPreferences>('SELECT enabled,uploads,evidence,participants,shipments,returns FROM user_notification_preferences WHERE user_id=$1',[user])).rows[0];
  return row??{...defaultNotificationPreferences};
}
export async function updateNotificationPreferences(db:Database,user:string,input:Record<string,unknown>){
  const keys=['enabled',...notificationCategories];
  if(Object.keys(input).some(k=>!keys.includes(k)||typeof input[k]!=='boolean'))throw new DomainError('INVALID_PREFERENCES','Notification settings must be on or off.',400);
  const next={...await notificationPreferences(db,user),...input};
  await db.query(`INSERT INTO user_notification_preferences(user_id,enabled,uploads,evidence,participants,shipments,returns) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(user_id) DO UPDATE SET enabled=$2,uploads=$3,evidence=$4,participants=$5,shipments=$6,returns=$7`,[user,...keys.map(k=>next[k as keyof typeof next])]);
  return next;
}
export async function muteProof(db:Database,user:string,proof:string,muted:unknown){
  await requireParticipant(db,proof,user);
  if(typeof muted!=='boolean')throw new DomainError('INVALID_PREFERENCES','Choose whether to mute this Proof.',400);
  if(muted)await db.query('INSERT INTO proof_notification_mutes(user_id,proof_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user,proof]);
  else await db.query('DELETE FROM proof_notification_mutes WHERE user_id=$1 AND proof_id=$2',[user,proof]);
  return {muted};
}
export async function reconcileProofUpdates(db:Database,clock:Clock){
  // The immutable source ID, never the title or client state, deduplicates this projection.
  const rows=(await db.query<{id:string;proof_id:string;event_type:string;created_at:Date|string;user_id:string}>(`WITH events AS (
    SELECT id,proof_id,event_type,created_at FROM audit_events WHERE event_type=ANY($1::text[])
    UNION ALL SELECT id,proof_id,event_type,created_at FROM shipment_events WHERE event_type IN ('LABEL_CREATED','CARRIER_ACCEPTED','IN_TRANSIT','ARRIVED_AT_FACILITY','DEPARTED_FACILITY','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_EXCEPTION','RETURN_TO_SENDER','RETURN_IN_TRANSIT','RETURN_DELIVERED')
  ) SELECT e.*,pp.user_id FROM events e JOIN proof_participants pp ON pp.proof_id=e.proof_id
    WHERE e.created_at>=$2 AND NOT EXISTS(SELECT 1 FROM proof_update_notifications n WHERE n.source_event_id=e.id AND n.user_id=pp.user_id)
    ORDER BY e.created_at,e.id LIMIT 250`,[['EVIDENCE_COMMITTED','PROOF_FINALIZED','ATTESTATION_COMMITTED','SELLER_PACKING_ATTESTED','EVIDENCE_UPLOAD_FAILED','PARTICIPANT_INVITED','PARTICIPANT_JOINED','INVITATION_ACCEPTED','TRACKING_ASSOCIATED','LIFECYCLE_EVIDENCE_COMMITTED','LIFECYCLE_STAGE_FINALIZED'],new Date(clock.now().getTime()-90*86400000).toISOString()])).rows;
  for(const row of rows){const meaning=proofUpdateMeaning(row.event_type);if(!meaning)continue;
    await db.query('INSERT INTO proof_update_notifications(id,proof_id,user_id,source_event_id,category,title,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[`notification_${sha256Hex(row.user_id+':'+row.id).slice(0,40)}`,row.proof_id,row.user_id,row.id,meaning.category,meaning.title,row.created_at]);
  }
  return {projected:rows.length};
}
export async function listProofUpdates(db:Database,user:string){
  await requireActiveAccount(db,user);
  return (await db.query(`SELECT n.id,n.proof_id AS "proofId",n.source_event_id AS "eventId",n.category,n.title,n.created_at AS "createdAt",n.read_at AS "readAt"
    FROM proof_update_notifications n JOIN proof_participants p ON p.proof_id=n.proof_id AND p.user_id=n.user_id WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,[user])).rows;
}
export async function registerPushDevice(db:Database,clock:Clock,user:string,token:unknown,active:unknown=true){
  await requireActiveAccount(db,user);
  if(typeof token!=='string'||!/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/.test(token)||typeof active!=='boolean')throw new DomainError('INVALID_PUSH_DEVICE','This device could not register for notifications.',400);
  if(!active){await db.query('UPDATE notification_push_devices SET active=false WHERE token=$1 AND user_id=$2',[token,user]);return;}
  await db.query(`INSERT INTO notification_push_devices(token,user_id,registered_at,active) VALUES($1,$2,$3,true)
    ON CONFLICT(token) DO UPDATE SET user_id=$2,registered_at=CASE WHEN notification_push_devices.user_id<>$2 THEN $3 ELSE notification_push_devices.registered_at END,active=true`,[token,user,clock.now().toISOString()]);
}
export async function dispatchProofPush(db:Database,clock:Clock,send:typeof fetch=fetch){
  await reconcileProofUpdates(db,clock);
  const now=clock.now().toISOString();
  // Do not send historical updates to newly registered devices. Muting leaves the history intact.
  await db.query(`INSERT INTO proof_push_deliveries(notification_id,token,next_attempt_at)
    SELECT n.id,d.token,$1 FROM proof_update_notifications n JOIN notification_push_devices d ON d.user_id=n.user_id AND d.active=true AND n.created_at>=d.registered_at
    WHERE n.created_at>=$2 ON CONFLICT DO NOTHING`,[now,new Date(clock.now().getTime()-86400000).toISOString()]);
  const rows=(await db.query<{notification_id:string;token:string;proof_id:string;user_id:string;source_event_id:string;category:NotificationCategory;title:string;attempts:number}>(`SELECT o.*,n.proof_id,n.user_id,n.source_event_id,n.category,n.title FROM proof_push_deliveries o
    JOIN proof_update_notifications n ON n.id=o.notification_id JOIN notification_push_devices d ON d.token=o.token AND d.user_id=n.user_id AND d.active=true
    JOIN proof_participants pp ON pp.proof_id=n.proof_id AND pp.user_id=n.user_id JOIN users u ON u.id=n.user_id AND u.status='ACTIVE'
    WHERE o.sent_at IS NULL AND o.attempts<5 AND o.next_attempt_at<=$1 AND (o.lease_until IS NULL OR o.lease_until<=$1) ORDER BY o.next_attempt_at LIMIT 20`,[now])).rows;
  let sent=0;
  for(const row of rows){
    const prefs=await notificationPreferences(db,row.user_id);
    const muted=(await db.query('SELECT 1 FROM proof_notification_mutes WHERE user_id=$1 AND proof_id=$2',[row.user_id,row.proof_id])).rows.length;
    if(!prefs.enabled||!prefs[row.category]||muted){await db.query("UPDATE proof_push_deliveries SET sent_at=$3,error_code='MUTED' WHERE notification_id=$1 AND token=$2",[row.notification_id,row.token,now]);continue;}
    const lease=new Date(clock.now().getTime()+60000).toISOString();
    const claimed=await db.query('UPDATE proof_push_deliveries SET lease_until=$3,attempts=attempts+1 WHERE notification_id=$1 AND token=$2 AND sent_at IS NULL AND (lease_until IS NULL OR lease_until<=$4) RETURNING notification_id',[row.notification_id,row.token,lease,now]);if(!claimed.rowCount)continue;
    try{
      const response=await send('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json',...(process.env.PACKPROOF_EXPO_PUSH_ACCESS_TOKEN?{Authorization:`Bearer ${process.env.PACKPROOF_EXPO_PUSH_ACCESS_TOKEN}`}:{})},body:JSON.stringify({to:row.token,title:row.title,body:'Open the update in your Proof.',channelId:`packproof_${row.category}`,sound:'default',data:{proofId:row.proof_id,eventId:row.source_event_id,userId:row.user_id,notificationId:row.notification_id,category:row.category},collapseId:row.notification_id,tag:row.notification_id}),signal:AbortSignal.timeout(10000)});
      const body=await response.json() as {data?:{status?:string;id?:string;details?:{error?:string}}};
      if(!response.ok||body.data?.status!=='ok'){
        if(body.data?.details?.error==='DeviceNotRegistered')await db.query('UPDATE notification_push_devices SET active=false WHERE token=$1',[row.token]);
        throw new Error('PUSH_DELIVERY_FAILED');
      }
      await db.query('UPDATE proof_push_deliveries SET sent_at=$3,ticket_id=$4,lease_until=NULL,error_code=NULL WHERE notification_id=$1 AND token=$2 AND lease_until=$5',[row.notification_id,row.token,clock.now().toISOString(),body.data.id??null,lease]);sent++;
    }catch{await db.query("UPDATE proof_push_deliveries SET lease_until=NULL,next_attempt_at=$3,error_code='PUSH_DELIVERY_FAILED' WHERE notification_id=$1 AND token=$2 AND lease_until=$4",[row.notification_id,row.token,new Date(clock.now().getTime()+30000*2**row.attempts).toISOString(),lease]);}
  }
  await checkPushReceipts(db,clock,send);
  return {sent};
}

async function checkPushReceipts(db:Database,clock:Clock,send:typeof fetch){
  const due=(await db.query<{notification_id:string;token:string;ticket_id:string}>(`SELECT notification_id,token,ticket_id FROM proof_push_deliveries
    WHERE ticket_id IS NOT NULL AND receipt_status IS NULL AND sent_at<=$1 AND (receipt_checked_at IS NULL OR receipt_checked_at<=$1) ORDER BY sent_at LIMIT 100`,[new Date(clock.now().getTime()-900000).toISOString()])).rows;
  if(!due.length)return;
  try{
    const response=await send('https://exp.host/--/api/v2/push/getReceipts',{method:'POST',headers:{'Content-Type':'application/json',...(process.env.PACKPROOF_EXPO_PUSH_ACCESS_TOKEN?{Authorization:`Bearer ${process.env.PACKPROOF_EXPO_PUSH_ACCESS_TOKEN}`}:{})},body:JSON.stringify({ids:due.map(r=>r.ticket_id)}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)return;
    const body=await response.json() as {data?:Record<string,{status?:string;details?:{error?:string}}>};
    for(const row of due){const receipt=body.data?.[row.ticket_id];
      await db.query('UPDATE proof_push_deliveries SET receipt_checked_at=$3,receipt_status=$4,error_code=COALESCE($5,error_code) WHERE notification_id=$1 AND token=$2',[row.notification_id,row.token,clock.now().toISOString(),receipt?.status??null,receipt?.details?.error??null]);
      if(receipt?.details?.error==='DeviceNotRegistered')await db.query('UPDATE notification_push_devices SET active=false WHERE token=$1',[row.token]);
    }
  }catch{/* Leave receipts due for the next bounded worker pass. */}
}
