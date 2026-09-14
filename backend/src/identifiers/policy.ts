import type {Database} from '../db/database.js';
import type {IdentifierPolicy, IdentifierSurface} from './types.js';
import {DomainError} from '../domain/errors.js';
const list=(value:string|undefined)=>new Set((value??'').split(',').map(x=>x.trim()).filter(Boolean));
/** Surface is a client declaration for feature rollout, never device-origin proof. */
export function captureSurface(client:string,declared?:unknown):IdentifierSurface {
  const surface=declared??(client==='WEB_CAMERA'?'WEB':'ANDROID');
  if(typeof surface!=='string' || !['ANDROID','IOS','WEB','WAREHOUSE'].includes(surface) ||
      (client==='WEB_CAMERA' && surface!=='WEB') || (client==='NATIVE_CAMERA' && surface==='WEB'))
    throw new DomainError('CAPTURE_SURFACE_INVALID','Declare the actual recording platform.',400);
  return surface as IdentifierSurface;
}
export async function identifierSessionPolicy(db:Database,actor:string,proofId:string,client:string,declared?:unknown):Promise<IdentifierPolicy> {
  const surface=captureSurface(client,declared);
  const row=(await db.query<{tenant_key:string;connection_id:string|null;owner_user_id:string|null}>(`SELECT o.tenant_key,o.connection_id,c.owner_user_id FROM proof_order_contexts p JOIN intake_order_snapshots s ON s.id=p.approved_snapshot_id JOIN intake_source_observations o ON o.id=s.observation_id LEFT JOIN integration_connections c ON c.id=o.connection_id AND c.status='ACTIVE' WHERE p.proof_id=$1`,[proofId])).rows[0];
  const eligible=Boolean(row&&row.owner_user_id===actor&&list(process.env.IDENTIFIER_TENANTS).has(row.tenant_key)&&list(process.env.IDENTIFIER_SURFACES).has(surface)&&(!process.env.IDENTIFIER_STORES||list(process.env.IDENTIFIER_STORES).has(row.connection_id??'')));
  const captureEnabled=eligible&&process.env.IDENTIFIER_CAPTURE_ENABLED==='true';
  return {version:1,surface,captureEnabled,autofillEnabled:captureEnabled&&process.env.IDENTIFIER_AUTOFILL_ENABLED==='true'&&process.env.IDENTIFIER_REVIEW_ENABLED==='true',reviewEnabled:captureEnabled&&process.env.IDENTIFIER_REVIEW_ENABLED==='true'};
}
