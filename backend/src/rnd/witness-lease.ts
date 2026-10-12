import { requireRnd } from './config.js';
import { bad } from './security.js';
import type { AnalysisRow,RndDeps } from './types.js';

export const WITNESS_LEASE_MS=90_000;
export const WITNESS_ATTEMPT_MS=600_000;
export type WitnessCheckpoint=()=>Promise<number>;

/** Renew only at bounded stage boundaries, never in a background keepalive. */
export function witnessLeaseCheckpoint(deps:RndDeps,job:AnalysisRow):WitnessCheckpoint {
 const initialLease=job.lease_until?new Date(job.lease_until).getTime():NaN;
 if(job.feature!=='proofwitness'||!job.lease_token||!Number.isFinite(initialLease))bad('RND_LEASE_LOST','Witness attempt has no valid lease',409);
 // Derive from acquisition, not from each renewal or from a later worker start.
 const deadline=initialLease-WITNESS_LEASE_MS+WITNESS_ATTEMPT_MS;
 return async()=>{
  requireRnd(deps.rnd,'proofwitness','processing');
  const now=deps.clock.now().getTime(),remaining=deadline-now;
  if(remaining<=0)bad('RND_WITNESS_DEADLINE','Witness attempt reached its bounded execution deadline',409);
  const until=Math.min(now+WITNESS_LEASE_MS,deadline);
  const renewed=await deps.db.query(`UPDATE rnd_analyses SET lease_until=$4
   WHERE id=$1 AND lease_token=$2 AND operational_state='RUNNING' AND lease_until>$3 RETURNING id`,
   [job.id,job.lease_token,new Date(now).toISOString(),new Date(until).toISOString()]);
  if(renewed.rowCount!==1)bad('RND_LEASE_LOST','Witness attempt no longer owns an unexpired lease',409);
  const after=deps.clock.now().getTime();
  if(after>=deadline)bad('RND_WITNESS_DEADLINE','Witness attempt reached its bounded execution deadline',409);
  if(after>=until)bad('RND_LEASE_LOST','Witness lease expired before its stage could start',409);
  return Math.min(deadline-after,60_000);
 };
}
