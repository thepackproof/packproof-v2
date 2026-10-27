import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { strictBody } from '../platform/organizations.js';
import { textField } from '../platform/tenants.js';
import { requireDossier } from './dossiers.js';
import { requireSite,audit,absent,type EnterpriseActor } from './access.js';
export async function startMeasurement(db:Database,clock:Clock,a:EnterpriseActor,id:string,input:unknown){
 const {order}=await requireDossier(db,clock,a,id,['ADMIN','REVIEWER']),b=strictBody(input,['studyKey','condition','complexity','question']);
 if(!['BASELINE','PACKPROOF'].includes(String(b.condition)))throw new DomainError('INVALID_REQUEST','Choose BASELINE or PACKPROOF',400);
 const measurementId=newId('measurement'),startedAt=clock.now().toISOString();
 await db.query('INSERT INTO enterprise_measurements(id,order_id,study_key,condition,complexity,question,reviewer_id,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[measurementId,id,textField(b.studyKey,'studyKey',100),b.condition,textField(b.complexity,'complexity',100),textField(b.question,'question',2000),a.userId,startedAt]);await audit(db,clock,a,order.site_id,'MEASUREMENT_STARTED',measurementId);return {id:measurementId,startedAt,condition:b.condition};
}
export async function finishMeasurement(db:Database,clock:Clock,a:EnterpriseActor,id:string,input:unknown){
 const m=(await db.query<{id:string;order_id:string;reviewer_id:string;started_at:string}>('SELECT * FROM enterprise_measurements WHERE id=$1',[id])).rows[0];if(!m||m.reviewer_id!==a.userId)throw absent();
 const {order}=await requireDossier(db,clock,a,m.order_id,['ADMIN','REVIEWER']),b=strictBody(input,['outcome','correctLinks','adjudicatedLinks','missingVisible','knownMissing','feedback']);
 if(!['COMPLETED','INCOMPLETE'].includes(String(b.outcome)))throw new DomainError('INVALID_REQUEST','Record task completion',400);
 for(const k of ['correctLinks','adjudicatedLinks','missingVisible','knownMissing'])if(!Number.isSafeInteger(b[k])||Number(b[k])<0||Number(b[k])>1000000)throw new DomainError('INVALID_REQUEST','Adjudication counts must be nonnegative integers',400);
 if(Number(b.correctLinks)>Number(b.adjudicatedLinks)||Number(b.missingVisible)>Number(b.knownMissing))throw new DomainError('INVALID_REQUEST','Numerators cannot exceed denominators',400);
 const elapsed=(clock.now().getTime()-new Date(m.started_at).getTime())/1000;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>7*86400)throw new DomainError('MEASUREMENT_WINDOW_INVALID','Review timing is outside supported window',409);
 await db.query('INSERT INTO enterprise_measurement_results(measurement_id,duration_seconds,outcome,correct_links,adjudicated_links,missing_visible,known_missing,feedback,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,elapsed,b.outcome,b.correctLinks,b.adjudicatedLinks,b.missingVisible,b.knownMissing,textField(b.feedback,'feedback',2000),clock.now().toISOString()]);await audit(db,clock,a,order.site_id,'MEASUREMENT_COMPLETED',id,{outcome:b.outcome,durationSeconds:elapsed});return {id,durationSeconds:elapsed};
}
export function distribution(values:number[]){
 const s=[...values].sort((a,b)=>a-b),n=s.length;return {n,min:n?s[0]:null,median:n?(n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2):null,p90:n?s[Math.ceil(n*.9)-1]:null,max:n?s[n-1]:null};
}
export async function pilotMetrics(db:Database,clock:Clock,a:EnterpriseActor,siteId:string){
 const site=await requireSite(db,clock,a,siteId,['ADMIN','REVIEWER']);
 const rows=(await db.query<{id:string;order_id:string;study_key:string;condition:string;complexity:string;question:string;reviewer_id:string;duration_seconds:string|null;outcome:string|null;correct_links:number|null;adjudicated_links:number|null;missing_visible:number|null;known_missing:number|null}>(`SELECT m.*,r.duration_seconds::text,r.outcome,r.correct_links,r.adjudicated_links,r.missing_visible,r.known_missing FROM enterprise_measurements m JOIN enterprise_orders o ON o.id=m.order_id LEFT JOIN enterprise_measurement_results r ON r.measurement_id=m.id WHERE o.site_id=$1 ORDER BY m.id`,[siteId])).rows;
 const complete=rows.filter(r=>r.outcome==='COMPLETED'),groups=[];
 for(const complexity of [...new Set(rows.map(r=>r.complexity))])for(const condition of ['BASELINE','PACKPROOF']){
  const cases=rows.filter(r=>r.complexity===complexity&&r.condition===condition),valid=complete.filter(r=>r.complexity===complexity&&r.condition===condition);
  groups.push({complexity,condition,started:cases.length,completed:valid.length,incomplete:cases.filter(r=>r.outcome==='INCOMPLETE').length,durationSeconds:distribution(valid.map(r=>Number(r.duration_seconds)))});
 }
 const pairs=[];for(const b of complete.filter(r=>r.condition==='BASELINE')){
  const p=complete.find(r=>r.condition==='PACKPROOF'&&r.order_id===b.order_id&&r.study_key===b.study_key&&r.reviewer_id===b.reviewer_id&&r.question===b.question&&r.complexity===b.complexity);
  if(p)pairs.push({baselineMeasurementId:b.id,packproofMeasurementId:p.id,complexity:b.complexity,baselineSeconds:Number(b.duration_seconds),packproofSeconds:Number(p.duration_seconds),differenceSeconds:Number(b.duration_seconds)-Number(p.duration_seconds)});
 }
 const judged=complete.filter(r=>r.condition==='PACKPROOF'),correct=judged.reduce((n,r)=>n+(r.correct_links??0),0),adjudicated=judged.reduce((n,r)=>n+(r.adjudicated_links??0),0),visible=judged.reduce((n,r)=>n+(r.missing_visible??0),0),missing=judged.reduce((n,r)=>n+(r.known_missing??0),0);
 await audit(db,clock,a,siteId,'PILOT_METRICS_VIEWED',siteId);
 return {schemaVersion:'packproof.enterprise.metrics/v1',siteId,synthetic:site.mode==='SYNTHETIC',groups,pairedComparison:{n:pairs.length,differenceSeconds:distribution(pairs.map(p=>p.differenceSeconds)),pairs},
 correctLinkRate:adjudicated?correct/adjudicated:null,adjudicatedLinks:adjudicated,incorrectDefinitiveLinks:adjudicated-correct,missingRecordVisibility:missing?visible/missing:null,knownMissing:missing,
 sourceIntegrity:'Ingest and retrieval digests are checked; no upstream truth claim.',operatorBurden:'Historical review adds no required fulfillment capture step; actual site burden remains to be evaluated.',
 limitations:['Synthetic results are not Winsupply performance measurements.','Adjudication counts are reviewer-reported and require partner validation.','Counterbalance review order and document learning effects.','Durations include pauses; report incomplete tasks and missing source materials.','Agree success thresholds after baseline; no ROI or fraud reduction is asserted.'],measurements:rows};
}
