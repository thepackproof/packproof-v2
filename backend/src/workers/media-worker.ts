import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {ObjectStore} from '../s3/object-store.js';
import {processPendingThumbnails} from '../domain/media-thumbnails.js';
export function startMediaWorker(db:Database,clock:Clock,store:ObjectStore) {
  let active:Promise<unknown>|null=null;
  const tick=()=>{if(active)return;active=processPendingThumbnails(db,clock,store).catch(()=>console.error(JSON.stringify({event:'media_worker_failed'}))).finally(()=>{active=null;});};
  const timer=setInterval(tick,5000);timer.unref();tick();
  return async()=>{clearInterval(timer);await active;};
}
