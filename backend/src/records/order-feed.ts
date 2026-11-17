import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {requireRecordLocation,type RecordWorkspace} from './access.js';
import {activeScope,installationOperation} from './order-workspace.js';
import type {Installation} from './agent-enrollments.js';
import {requireReconstructionFeature} from './reconstruction-features.js';

interface Filter{where:string;params:unknown[];}
const currentRecord=`EXISTS(SELECT 1 FROM platform_proof_ownership owner JOIN record_state state ON state.proof_id=owner.proof_id
 WHERE owner.proof_id=r.proof_id AND owner.merchant_id=r.organization_id AND owner.environment=r.environment
 AND owner.operator_membership_id=r.operator_membership_id AND state.location_id IS NOT DISTINCT FROM r.location_id)`;
export const currentOrderScope=(f:Filter):Filter=>({...f,where:'('+f.where+') AND '+currentRecord});
export async function humanOrderFilter(db:Database,w:RecordWorkspace,locationId?:unknown):Promise<Filter>{
 requireReconstructionFeature('orderWorkspace');
 const location=locationId==null||locationId===''?null:await requireRecordLocation(db,w,locationId);
 return {where:`r.organization_id=$1 AND r.environment=$2 AND ($3::boolean=false OR r.operator_membership_id=$4) AND ($5::boolean=false OR EXISTS(
 SELECT 1 FROM record_membership_locations g WHERE g.organization_id=r.organization_id AND g.membership_id=$4 AND g.location_id=r.location_id))
 AND ($6::text IS NULL OR r.location_id=$6)`,params:[w.organizationId,w.environment,w.role==='OPERATOR',w.membershipId,w.locationScoped,location]};
}
export async function agentOrderFilter(db:Database,i:Installation):Promise<Filter>{
 await activeScope(db,i);
 return {where:'r.operation_key=$1',params:[installationOperation(i)]};
}
function count(v:unknown,fallback:number,max=100){
 if(v==null)return fallback;
 const n=typeof v==='string'&&/^\d+$/.test(v)?Number(v):v;
 if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>max)throw new DomainError('INVALID_LIMIT','Choose a supported page size or revision.',400);
 return n;
}
export async function orderChanges(db:Database,f:Filter,after:unknown,limit:unknown){
 const n=after==null?0:typeof after==='string'&&/^\d+$/.test(after)?Number(after):after;
 if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw new DomainError('INVALID_CURSOR','Refresh orders to start a new feed.',400);
 f=currentOrderScope(f);
 const size=count(limit,50),j=f.params.length;
 const all=(await db.query<{sequence:string;proof_id:string;revision:number}>(`SELECT v.sequence,v.proof_id,v.revision FROM record_order_revisions v JOIN record_order_roots r ON r.proof_id=v.proof_id WHERE ${f.where} AND v.sequence>$${j+1} ORDER BY v.sequence LIMIT $${j+2}`,[...f.params,n,size+1])).rows;
 const changes=all.slice(0,size).map(v=>({sequence:Number(v.sequence),proofId:v.proof_id,revision:v.revision}));
 return {changes,nextCursor:changes.at(-1)?.sequence??n,hasMore:all.length>size};
}
export async function listOrders(db:Database,f:Filter,q:unknown,limit:unknown){
 if(q!=null&&(typeof q!=='string'||q.length>200))throw new DomainError('INVALID_SEARCH','Enter an exact order reference.',400);
 f=currentOrderScope(f);
 const j=f.params.length;
 // Rows and boundary share a single MVCC statement snapshot. The high watermark
 // includes all visible rows even when the caller only displays the latest 20.
 const row=(await db.query<{orders:{proofId:string;revision:number;orderReference:string;updatedAt:string}[];cursor:string}>(`WITH visible AS (
 SELECT last.sequence,last.revision,last.committed_at,r.proof_id,r.order_reference FROM record_order_roots r
 JOIN LATERAL (SELECT v.sequence,v.revision,v.committed_at FROM record_order_revisions v WHERE v.proof_id=r.proof_id ORDER BY v.revision DESC LIMIT 1) last ON true WHERE ${f.where}
 ), page AS (SELECT * FROM visible WHERE ($${j+1}::text='' OR order_reference=$${j+1}) ORDER BY sequence DESC LIMIT $${j+2})
 SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('proofId',proof_id,'revision',revision,'orderReference',order_reference,'updatedAt',committed_at) ORDER BY sequence DESC) FROM page),'[]'::jsonb) orders,COALESCE((SELECT max(sequence) FROM visible),0) cursor`,[...f.params,q??'',count(limit,20)])).rows[0];
 return {orders:row.orders,cursor:Number(row.cursor)};
}
export async function readOrder(db:Database,f:Filter,id:string,revision?:unknown){
 f=currentOrderScope(f);
 const j=f.params.length,v=revision===undefined?null:count(revision,1,2147483647);
 const row=(await db.query<{view:unknown}>(`SELECT v.view FROM record_order_roots r JOIN record_order_revisions v ON v.proof_id=r.proof_id WHERE ${f.where} AND r.proof_id=$${j+1} AND ($${j+2}::integer IS NULL OR v.revision=$${j+2}) ORDER BY v.revision DESC LIMIT 1`,[...f.params,id,v])).rows[0];
 if(!row)throw new DomainError('PROOF_NOT_FOUND','This order revision could not be found in your workspace.',404);
 return row.view;
}
