import {loadConfig,loadEnvFile} from '../config.js';
import {openDatabase} from '../db/open.js';
loadEnvFile();
const opened=await openDatabase(loadConfig());
try{
  const probes={
    workers:'SELECT worker_name,COUNT(*)::int AS instances,MAX(heartbeat_at) AS latest_heartbeat,MAX(last_success_at) AS latest_success FROM operational_worker_heartbeats GROUP BY worker_name ORDER BY worker_name',
    preservation:"SELECT d.state,COUNT(*)::int AS count,MIN(e.created_at) AS oldest_created_at FROM recovery_delivery d JOIN recovery_events e USING(operation_id) WHERE d.state<>'DURABLE' GROUP BY d.state",
    exports:"SELECT state,COUNT(*)::int AS count,MIN(created_at) AS oldest_created_at FROM recipient_export_jobs WHERE state<>'READY' GROUP BY state",
    declarations:"SELECT COUNT(*)::int AS count FROM attestation_challenges WHERE consumed_at IS NULL AND expires_at>NOW()",
  };
  const results=await Promise.all(Object.entries(probes).map(async([name,sql])=>{try{return [name,{status:'available',rows:(await opened.db.query(sql)).rows}];}catch{return [name,{status:'unavailable'}];}}));
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),...Object.fromEntries(results)},null,2));
}finally{await opened.close();}
