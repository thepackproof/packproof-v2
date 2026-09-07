import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';

export interface ScheduledJob { name:string; intervalMs:number; run:()=>Promise<unknown>; }
/** Each callback owns its domain lease. A hung callback never overlaps itself. */
export function startScheduledJobs(db:Database,clock:Clock,jobs:ScheduledJob[]) {
  const instanceId=randomUUID(); let stopping=false;
  const running=new Map<string,Promise<void>>();
  const beat=async(name:string,state:string,success:boolean)=>{
    await db.query(`INSERT INTO operational_worker_heartbeats(worker_name,instance_id,heartbeat_at,last_success_at,state)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_name,instance_id) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at,
      last_success_at=COALESCE(EXCLUDED.last_success_at,operational_worker_heartbeats.last_success_at),state=EXCLUDED.state`,
      [name,instanceId,clock.now().toISOString(),success?clock.now().toISOString():null,state]);
  };
  const timers=jobs.map(job=>{
    const tick=()=>{
      if(stopping||running.has(job.name))return;
      const active=(async()=>{
        await beat(job.name,'RUNNING',false);
        const result=await job.run();
        if(result&&typeof result==='object'&&('state' in result&&result.state==='DEAD_LETTER'||'failed' in result&&Number(result.failed)>0))throw new Error('Scheduled work did not complete successfully');
        await beat(job.name,'IDLE',true);
      })().catch(async()=>{
        console.error(JSON.stringify({event:'scheduled_job_failed',worker:job.name,instanceId}));
        try{await beat(job.name,'ERROR',false);}catch{/* The missing heartbeat also raises the alarm. */}
      }).finally(()=>running.delete(job.name));
      running.set(job.name,active);
    };
    const timer=setInterval(tick,job.intervalMs); timer.unref(); tick(); return timer;
  });
  return async()=>{stopping=true;timers.forEach(clearInterval);await Promise.all(running.values());};
}
