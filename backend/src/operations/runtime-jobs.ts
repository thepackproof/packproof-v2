import { processPolicyRecoveryOutbox } from "../domain/policy-recovery.js";
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import type { AppConfig } from '../config.js';
import type { ManifestSigningRuntime } from '../integrity/signing-runtime.js';
import { processRecoveryOutbox, type RecoveryPublisher } from '../domain/recovery-journal.js';
import { sweepExpiredMediaAdmissions } from '../domain/media-admission.js';
import { processRecipientExport } from '../domain/recipient-exports.js';
import { processPendingThumbnails } from '../domain/media-thumbnails.js';
import { reconcileDurableFinalizedUsage } from '../billing/usage-ledger.js';
import { reconcileAllProofNotifications,dispatchPendingProofEmails } from '../domain/proof-notifications.js';
import { createEmailDeliveryFromEnv } from '../integrations/email/delivery.js';
import { startScheduledJobs, type ScheduledJob } from './scheduler.js';

export function createRecoveryPublisher(config:AppConfig,store:ObjectStore,signing:ManifestSigningRuntime,clock:Clock,env:NodeJS.ProcessEnv=process.env):RecoveryPublisher|undefined {
  const enabled=env.PACKPROOF_RECOVERY_WORKER==='true'||config.requireDurableReceipts===true;
  if(!enabled)return undefined;
  const generation=env.PACKPROOF_RECOVERY_WRITER_GENERATION?.trim();
  if(!generation||!store.putIfAbsent||!store.head||store.immutableRecoveryJournal!==true||!signing.signer||!signing.trustList)
    throw new Error('Durable preservation requires a verified immutable journal, signing trust, and explicit writer generation');
  return {store:{putIfAbsent:store.putIfAbsent.bind(store),get:store.get.bind(store),head:store.head?.bind(store)},signer:signing.signer,
    writerGeneration:generation,protectedStoreVerified:true,trustedPublicKey:async keyId=>{
      const trust=signing.trustList;
      if(!trust||Date.parse(trust.generatedAt)>clock.now().getTime()||Date.parse(trust.expiresAt)<=clock.now().getTime())return null;
      return trust.keys.find(key=>key.keyId===keyId&&key.status==='ACTIVE')?.publicKeyPem??null;
    }};
}
export function startOperationsWorkers(db:Database,clock:Clock,store:ObjectStore,config:AppConfig,publisher?:RecoveryPublisher,env:NodeJS.ProcessEnv=process.env,extraJobs:ScheduledJob[]=[]) {
  const jobs:ScheduledJob[]=[...extraJobs,
    {name:'usage-reconciliation',intervalMs:30000,run:()=>reconcileDurableFinalizedUsage(db,clock)},
    {name:'operational-cleanup',intervalMs:3600000,run:async()=>{
      await db.query('DELETE FROM http_rate_windows WHERE expires_at<$1',[clock.now().toISOString()]);
      await db.query('DELETE FROM operational_worker_heartbeats WHERE heartbeat_at<$1',[new Date(clock.now().getTime()-7*86400000).toISOString()]);
    }},
  ];
  if(env.PACKPROOF_MEDIA_WORKER!=='false')jobs.push({name:'thumbnails',intervalMs:5000,run:()=>processPendingThumbnails(db,clock,store)});
  if(env.PACKPROOF_RECIPIENT_EXPORT_WORKER!=='false')jobs.push({name:'recipient-exports',intervalMs:5000,run:()=>processRecipientExport(db,clock,store)});
  if(publisher){
    jobs.push({name:'preservation',intervalMs:2000,run:()=>processRecoveryOutbox(db,clock,publisher)});
    jobs.push({name:'policy-recovery',intervalMs:1000,run:async()=>{for(let i=0;i<20;i++){const result=await processPolicyRecoveryOutbox(db,clock,publisher);if(!result.processed)break;}}});
  }
  // Explicit maintenance authorization is needed for staging deletion in hosted storage.
  if(env.PACKPROOF_STAGING_CLEANUP_WORKER==='true')jobs.push({name:'staging-cleanup',intervalMs:60000,run:()=>sweepExpiredMediaAdmissions(db,clock,store,25)});
  const delivery=createEmailDeliveryFromEnv(env),secret=env.PACKPROOF_TRACKER_LINK_SECRET??(config.devAuth?'packproof-development-tracker-link-secret-v1':'');
  const webUrl=config.webOrigins.find(origin=>origin.startsWith('http'))??config.publicBaseUrl;
  if(delivery.enabled&&secret)jobs.push({name:'notifications',intervalMs:30000,run:async()=>{
    await reconcileAllProofNotifications(db,clock);
    await dispatchPendingProofEmails(db,clock,delivery,webUrl,secret);
  }});
  return startScheduledJobs(db,clock,jobs);
}
