import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';
import type {SourceOutcomeCounts} from './coverage.js';

export interface ProjectionSourceCounter {
 subscriptionId:string;ready:boolean;counts:SourceOutcomeCounts;unknownTimeCount:number;
}
export async function readProjectionSourceCounter(db:Database,subscriptionId:string):Promise<ProjectionSourceCounter>{
 const r=(await db.query<Record<string,string|number|boolean>>('SELECT * FROM record_source_projection_counters WHERE subscription_id=$1',[subscriptionId])).rows[0];
 return {subscriptionId,ready:r?.ready===true,counts:{received:Number(r?.received_count??0),processing:Number(r?.processing_count??0),acceptedLinked:Number(r?.linked_count??0),acceptedUnlinked:Number(r?.unlinked_count??0),duplicate:Number(r?.duplicate_count??0),conflict:Number(r?.conflict_count??0),quarantined:Number(r?.quarantined_count??0),rejected:Number(r?.rejected_count??0)},unknownTimeCount:Number(r?.unknown_time_count??0)};
}
/** One aggregate initializes an existing source's derived baseline. Admission
 * triggers use the same lock, so a concurrent insert/update cannot be lost or
 * counted twice. Future reads use O(1) counters rather than scanning history. */
export async function reconcileProjectionSourceCounter(db:Database,clock:Clock,subscriptionId:string){
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438166,hashtext($1))',[subscriptionId]);
  const source=(await tx.query<{organization_id:string;environment:string;location_id:string;operator_membership_id:string}>('SELECT organization_id,environment,location_id,operator_membership_id FROM record_source_subscriptions WHERE id=$1',[subscriptionId])).rows[0];
  if(!source)throw new DomainError('SOURCE_SUBSCRIPTION_NOT_FOUND','Source subscription not found',404);
  const c=(await tx.query<Record<string,string>>(`SELECT COUNT(*)::text received_count,
   COUNT(*) FILTER(WHERE r.status='processing')::text processing_count,
   COUNT(*) FILTER(WHERE r.status='accepted_linked')::text linked_count,
   COUNT(*) FILTER(WHERE r.status='accepted_unlinked')::text unlinked_count,
   COUNT(*) FILTER(WHERE r.status='duplicate')::text duplicate_count,
   COUNT(*) FILTER(WHERE r.status='conflict')::text conflict_count,
   COUNT(*) FILTER(WHERE r.status='quarantined')::text quarantined_count,
   COUNT(*) FILTER(WHERE r.status='rejected')::text rejected_count,
   COUNT(*) FILTER(WHERE r.history_eligibility='unknown' AND r.status IN ('accepted_linked','accepted_unlinked'))::text unknown_time_count
   FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE b.subscription_id=$1`,[subscriptionId])).rows[0];
  await tx.query(`INSERT INTO record_source_projection_counters(subscription_id,organization_id,environment,location_id,operator_membership_id,received_count,processing_count,linked_count,unlinked_count,duplicate_count,conflict_count,quarantined_count,rejected_count,unknown_time_count,ready,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15)
   ON CONFLICT(subscription_id) DO UPDATE SET received_count=EXCLUDED.received_count,processing_count=EXCLUDED.processing_count,linked_count=EXCLUDED.linked_count,unlinked_count=EXCLUDED.unlinked_count,duplicate_count=EXCLUDED.duplicate_count,conflict_count=EXCLUDED.conflict_count,quarantined_count=EXCLUDED.quarantined_count,rejected_count=EXCLUDED.rejected_count,unknown_time_count=EXCLUDED.unknown_time_count,ready=true,updated_at=EXCLUDED.updated_at`,[subscriptionId,source.organization_id,source.environment,source.location_id,source.operator_membership_id,c.received_count,c.processing_count,c.linked_count,c.unlinked_count,c.duplicate_count,c.conflict_count,c.quarantined_count,c.rejected_count,c.unknown_time_count,clock.now().toISOString()]);
  return readProjectionSourceCounter(tx,subscriptionId);
 });
}
export const sourceProjectionSignature=(sources:unknown)=>sha256Hex(canonicalize(sources));

/** Receipt totals and advancing boundaries are presentation measurements. They
 * do not invalidate an unchanged case comparison. Qualification, source version
 * and non-monotone boundaries are checked separately before serving the cache. */
export function projectionSourceDependencies(sources:import('./coverage.js').SourceCoverage[]){
 return sources.map(s=>({subscriptionId:s.subscriptionId??null,configurationRevision:s.configurationRevision??null,connectionId:s.connectionId,sourceNamespace:s.sourceNamespace,state:['current','quiet_checked'].includes(s.state)?'ready':s.state,coverage:s.coverage,accountingAvailable:(s as typeof s&{accountingAvailable?:boolean}).accountingAvailable!==false,completeness:{kind:s.completeness.kind,scope:s.completeness.scope??null,qualificationReference:s.completeness.qualificationReference},rulePolicies:s.rulePolicies??null}));
}
export function projectionSourceBoundariesCurrent(previous:import('./coverage.js').SourceCoverage[],current:import('./coverage.js').SourceCoverage[]){
 return previous.every(before=>{const after=current.find(s=>s.subscriptionId===before.subscriptionId&&s.connectionId===before.connectionId&&s.sourceNamespace===before.sourceNamespace);if(!after)return false;const left=before.completeness.asOf,right=after.completeness.asOf;return left===null||right!==null&&Date.parse(right)>=Date.parse(left);});
}
