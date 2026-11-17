import {createHash} from 'node:crypto';
import {readFile,rename,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import type {Database} from '../src/db/database.js';

interface Sample {
  ref:string;
  published:number;
  committed?:number;
  accepted?:number;
  dashboard?:number;
  output?:number;
  proofId?:string;
}
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];

export async function measureOrderLatency(db:Database,root:string,count:number,driverFailed:()=>boolean=()=>false){
  if(!Number.isSafeInteger(count)||count<5||count>40)throw Error('Choose 5 to 40 observations');
  const samples:Sample[]=[];
  // One small file per second while the listener, collector and materializer stay connected.
  const publish=async()=>{
    for(let i=1;i<=count;i++){
      const ref='SAMPLE-PERF-'+String(i).padStart(3,'0');
      const target=path.join(root,'order',ref+'.json');
      const record={eventId:ref,version:'1',kind:'order',entityNamespace:'ERP_BENCH',entityType:'order',entityId:ref,
        occurredAt:new Date().toISOString(),lines:[{lineId:'1',sku:'BENCH',orderedQuantity:'1',unit:'each'}]};
      await writeFile(target+'.tmp',JSON.stringify(record));
      const published=Date.now();await rename(target+'.tmp',target);samples.push({ref,published});
      await wait(1000);
    }
  };
  const observed=async()=>{
    const deadline=Date.now()+count*1000+80000;
    while(Date.now()<deadline) {
      if(driverFailed())throw Error("Native service driver stopped during performance measurement at "+samples.length+" orders");
      const result=await db.query<{order_reference:string;proof_id:string;committed_at:Date|string;received_at:Date|string}>(
        'SELECT r.order_reference,r.proof_id,v.committed_at,t.received_at FROM record_order_roots r JOIN record_order_revisions v ON r.proof_id=v.proof_id AND v.revision=1 JOIN record_order_receipts t ON t.operation_key=r.operation_key AND t.file_name=r.order_reference||\'.json\' WHERE r.order_reference LIKE \'SAMPLE-PERF-%\'');
      for(const row of result.rows) {
        const sample=samples.find(s=>s.ref===row.order_reference);
        if(sample){sample.committed=Date.parse(new Date(row.committed_at).toISOString());sample.accepted=new Date(row.received_at).valueOf();sample.proofId=row.proof_id;}
      }
      const status=await readFile(path.join(root,'service-status.json'),'utf8').then(s=>JSON.parse(s)).catch(()=>null);
      const list=(status?.workspace?.orders||[]) as {orderReference:string;revision:number}[];
      for(const item of samples) {
        if(!item.dashboard&&list.some(v=>v.orderReference===item.ref&&v.revision===1))item.dashboard=new Date(status.at).valueOf();
        if(!item.output&&item.proofId){
          const folder=item.ref+' - '+createHash('sha256').update(item.proofId).digest('hex').slice(0,24);
          const summary=await stat(path.join(root,'output',folder,'current.html')).catch(()=>null);
          if(summary)item.output=Math.round(summary.mtimeMs);
        }
      }
      if(samples.length===count&&samples.every(s=>s.output&&s.committed&&s.dashboard&&s.accepted))return;
      await wait(180);
    }
    throw Error('Unobserved benchmark stages '+samples.filter(s=>!s.dashboard||!s.output||!s.committed).map(s=>s.ref+'/'+[!!s.committed,!!s.dashboard,!!s.output].join('-')).join(','));
  };
  await Promise.all([publish(),observed()]);
  const metric=(values:number[],target:number)=>({count:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:Math.max(...values),
    targetMs:target,met:percentile(values,.95)<=target});
  return {count,scope:'isolated Windows service scheduler, local file publication, HTTP API and local disk. Dashboard timing observes the desktop data feed; display paint is separate.',
    nearestRank:true,intervalMs:1000,samplePollMs:180,
    publishToAccepted:metric(samples.map(s=>s.accepted!-s.published),5000),publishToCommitted:metric(samples.map(s=>s.committed!-s.published),5000),
    commitToDashboardFeed:metric(samples.map(s=>s.dashboard!-s.committed!),2000),commitToOutput:metric(samples.map(s=>s.output!-s.committed!),30000),samples};
}
