import type {Database} from '../db/database.js';
import type {TypedSourceCompleteness} from './source-contracts.js';

interface SnapshotBatch {id:string;contract:{completeness?:TypedSourceCompleteness};received_at:Date|string;state:string;csv_snapshot_boundary_at:Date|string|null;}
export interface SourceSnapshotReadState {completeness:TypedSourceCompleteness;boundaryReceiptId:string|null;unqualifiedLive:boolean;futureLatestInput:boolean;hasUnreconciledReceipts:boolean;}
/** A historical upload may advance knowledge, but receipt order cannot replace
 * a newer source boundary. Retained incomplete/current inputs remain blockers. */
export async function readSourceSnapshotState(db:Database,input:{subscriptionId:string;organizationId:string;environment:string;locationId:string;operatorMembershipId:string;sourceNamespace:string;configurationRevision:number;now:string}):Promise<SourceSnapshotReadState>{
 const p=[input.subscriptionId,input.organizationId,input.environment,input.locationId,input.operatorMembershipId,input.sourceNamespace,input.configurationRevision,input.now];
 const scope=`b.subscription_id=$1 AND b.organization_id=$2 AND b.environment=$3 AND b.location_id=$4 AND b.operator_membership_id=$5 AND b.source_namespace=$6 AND b.configuration_revision=$7`;
 const [boundary,latestLive,latestInput,pending]=await Promise.all([
  db.query<SnapshotBatch>(`SELECT b.id,b.contract,b.received_at,b.state,b.csv_snapshot_boundary_at FROM record_typed_batches b WHERE ${scope} AND b.state='succeeded' AND b.csv_snapshot_boundary_at IS NOT NULL AND b.csv_snapshot_boundary_at<=$8::timestamptz AND b.csv_snapshot_boundary_at<=b.received_at ORDER BY b.csv_snapshot_boundary_at DESC,b.received_at DESC,b.id DESC LIMIT 1`,p),
  db.query<SnapshotBatch>(`SELECT b.id,b.contract,b.received_at,b.state,b.csv_snapshot_boundary_at FROM record_typed_batches b WHERE ${scope} AND COALESCE(b.contract->'collectionContext'->>'kind','')<>'historical_backfill' ORDER BY b.received_at DESC,b.id DESC LIMIT 1`,p.slice(0,7)),
  db.query<SnapshotBatch>(`SELECT b.id,b.contract,b.received_at,b.state,b.csv_snapshot_boundary_at FROM record_typed_batches b WHERE ${scope} ORDER BY b.received_at DESC,b.id DESC LIMIT 1`,p.slice(0,7)),
  db.query<{id:string}>(`SELECT b.id FROM record_typed_batches b WHERE ${scope} AND (b.state<>'succeeded' OR b.csv_snapshot_boundary_at IS NULL) LIMIT 1`,p.slice(0,7))
 ]);
 const live=latestLive.rows[0],latest=latestInput.rows[0],control=live?.contract.completeness;
 const future=(batch:SnapshotBatch|undefined)=>!!batch?.csv_snapshot_boundary_at&&(new Date(batch.csv_snapshot_boundary_at).getTime()>Date.parse(input.now)||new Date(batch.csv_snapshot_boundary_at).getTime()>new Date(batch.received_at).getTime());
 const measured=boundary.rows[0];
 return {completeness:measured?.contract.completeness??{kind:'unknown',asOf:null,marker:null},boundaryReceiptId:measured?.id??null,unqualifiedLive:!live||control?.kind!=='snapshot'||!control.asOf||!control.marker||live.csv_snapshot_boundary_at===null||future(live),futureLatestInput:future(latest),hasUnreconciledReceipts:pending.rows.length>0};
}
