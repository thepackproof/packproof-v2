import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {ObjectStore} from '../s3/object-store.js';
import {processRecipientExport} from '../domain/recipient-exports.js';
export function startRecipientExportWorker(db:Database,clock:Clock,store:ObjectStore){let active:Promise<unknown>|null=null;const tick=()=>{if(active)return;active=processRecipientExport(db,clock,store).catch(()=>console.error(JSON.stringify({event:'recipient_export_worker_failed'}))).finally(()=>{active=null;});};const timer=setInterval(tick,5000);timer.unref();tick();return async()=>{clearInterval(timer);await active;};}
