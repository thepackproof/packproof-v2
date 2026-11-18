import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireRecordLocation, type RecordWorkspace } from './access.js';
import { activeScope, installationOperation } from './order-workspace.js';
import type { Installation } from './agent-enrollments.js';
import { requireReconstructionFeature } from './reconstruction-features.js';
interface Filter {
  where: string;
  params: unknown[];
}
const currentRecord = `EXISTS(SELECT 1 FROM platform_proof_ownership owner JOIN record_state state ON state.proof_id=owner.proof_id
 WHERE owner.proof_id=r.proof_id AND owner.merchant_id=r.organization_id AND owner.environment=r.environment
 AND owner.operator_membership_id=r.operator_membership_id AND state.location_id IS NOT DISTINCT FROM r.location_id)`;
export const currentOrderScope = (f: Filter): Filter => ({
  ...f,
  where: '(' + f.where + ') AND ' + currentRecord
});
export async function humanOrderFilter(db: Database, w: RecordWorkspace, locationId?: unknown): Promise<Filter> {
  requireReconstructionFeature('orderWorkspace');
  const location = locationId == null || locationId === '' ? null : await requireRecordLocation(db, w, locationId);
  return {
    where: `r.organization_id=$1 AND r.environment=$2 AND ($3::boolean=false OR r.operator_membership_id=$4) AND ($5::boolean=false OR EXISTS(
 SELECT 1 FROM record_membership_locations g WHERE g.organization_id=r.organization_id AND g.membership_id=$4 AND g.location_id=r.location_id))
 AND ($6::text IS NULL OR r.location_id=$6)`,
    params: [w.organizationId, w.environment, w.role === 'OPERATOR', w.membershipId, w.locationScoped, location]
  };
}
export async function agentOrderFilter(db: Database, i: Installation): Promise<Filter> {
  await activeScope(db, i);
  return {
    where: 'r.operation_key=$1',
    params: [installationOperation(i)]
  };
}
function count(v: unknown, fallback: number, max = 100) {
  if (v == null) return fallback;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) throw new DomainError('INVALID_LIMIT', 'Choose a supported page size or revision.', 400);
  return n;
}
export async function orderChanges(db: Database, f: Filter, after: unknown, limit: unknown) {
  const n = after == null ? 0 : typeof after === 'string' && /^\d+$/.test(after) ? Number(after) : after;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new DomainError('INVALID_CURSOR', 'Refresh orders to start a new feed.', 400);
  f = currentOrderScope(f);
  const size = count(limit, 50),
    j = f.params.length;
  const all = (await db.query<{
    sequence: string;
    proof_id: string;
    revision: number;
  }>(`SELECT v.sequence,v.proof_id,v.revision FROM record_order_revisions v JOIN record_order_roots r ON r.proof_id=v.proof_id WHERE ${f.where} AND v.sequence>$${j + 1} ORDER BY v.sequence LIMIT $${j + 2}`, [...f.params, n, size + 1])).rows;
  const changes = all.slice(0, size).map(v => ({
    sequence: Number(v.sequence),
    proofId: v.proof_id,
    revision: v.revision
  }));
  return {
    changes,
    nextCursor: changes.at(-1)?.sequence ?? n,
    hasMore: all.length > size
  };
}
interface OrderCard {
  proofId: string;
  revision: number;
  orderReference: string;
  updatedAt: string;
  customerName?: string;
  latestKind?: string;
  fulfillmentStatus?: string;
  issue?: string;
}
// The projection orders events chronologically and records only unit-compatible
// discrepancies. Customer identity must be explicitly reported by an order origin.
const firstIssue = `COALESCE(
 jsonb_path_query_first(v.view, '$.lines[*].loadedAcknowledgedDiscrepancy') #>> '{}',
 jsonb_path_query_first(v.view, '$.lines[*].orderedShippedDiscrepancy') #>> '{}',
 CASE WHEN jsonb_array_length(COALESCE(v.view->'conflicts','[]'::jsonb))>0 THEN 'Conflicting source values' END)`;
const orderLabels = `(SELECT COALESCE(jsonb_object_agg(label,value),'{}'::jsonb) FROM (
 SELECT label,left(min(name),200) AS value FROM (
  SELECT CASE lower(replace(replace(f.key,'_',''),' ',''))
   WHEN 'customer' THEN 'customerName' WHEN 'customername' THEN 'customerName' WHEN 'soldtoname' THEN 'customerName'
   WHEN 'fulfillmentstatus' THEN 'fulfillmentStatus' WHEN 'fulfilmentstatus' THEN 'fulfillmentStatus' END AS label,
   nullif(trim(f.value #>> '{}'),'') AS name
  FROM jsonb_array_elements(v.view->'events') e
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e->'fields')='object' THEN e->'fields' ELSE '{}'::jsonb END) f
  WHERE e->>'kind'='order' AND jsonb_typeof(f.value)='string') candidates
 WHERE label IS NOT NULL AND name IS NOT NULL GROUP BY label HAVING min(name)=max(name)) unambiguous)`;
const card = `(jsonb_strip_nulls(jsonb_build_object(
 'proofId',p.proof_id,'revision',p.revision,'orderReference',p.order_reference,'updatedAt',p.committed_at,
 'latestKind',v.view->'events'->-1->>'kind','issue',left(${firstIssue},200))) || ${orderLabels})`;
function visibleOrders(f: Filter) {
  return `SELECT last.sequence,last.revision,last.committed_at,r.proof_id,r.order_reference FROM record_order_roots r
 JOIN LATERAL (SELECT v.sequence,v.revision,v.committed_at FROM record_order_revisions v WHERE v.proof_id=r.proof_id ORDER BY v.revision DESC LIMIT 1) last ON true WHERE ${f.where}`;
}
export async function listOrders(db: Database, f: Filter, q: unknown, limit: unknown, before?: unknown, dayStart?: unknown) {
  if (q != null && (typeof q !== 'string' || q.length > 200)) throw new DomainError('INVALID_SEARCH', 'Enter an exact order reference.', 400);
  if (dayStart != null && (typeof dayStart !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(dayStart) || !Number.isFinite(Date.parse(dayStart)) || new Date(dayStart).toISOString().slice(0,19)!==dayStart.slice(0,19))) {
    throw new DomainError('INVALID_DAY_START', 'Supply the local start of today as a UTC timestamp.', 400);
  }
  const boundary = before == null ? null : count(before, 1, Number.MAX_SAFE_INTEGER);
  f = currentOrderScope(f);
  const j = f.params.length, size = count(limit, 20);
  // Authorize and bound the page before reading proof documents for card details.
  const row = (await db.query<{orders:OrderCard[];cursor:string;total:number;updated:number;today:number;next_before:string|null}>(`
 WITH visible AS MATERIALIZED (${visibleOrders(f)}),
 matches AS (SELECT * FROM visible WHERE ($${j+1}::text='' OR order_reference=$${j+1})
 AND ($${j+3}::bigint IS NULL OR sequence<$${j+3}) ORDER BY sequence DESC LIMIT ($${j+2}::integer + 1)),
 page AS (SELECT * FROM matches ORDER BY sequence DESC LIMIT $${j+2})
 SELECT COALESCE((SELECT jsonb_agg(${card} ORDER BY p.sequence DESC) FROM page p
 JOIN record_order_revisions v ON v.sequence=p.sequence),'[]'::jsonb) orders,
 COALESCE(max(sequence),0) cursor,count(*)::integer total,
 count(*) FILTER (WHERE committed_at>=now()-interval '24 hours')::integer updated,
 count(*) FILTER (WHERE committed_at >= $${j+4}::timestamptz)::integer today,
 CASE WHEN (SELECT count(*) FROM matches)>$${j+2} THEN (SELECT min(sequence) FROM page) END next_before
 FROM visible`, [...f.params,q ?? '',size,boundary,dayStart ?? null])).rows[0];
  return {orders:row.orders,cursor:Number(row.cursor),totalOrders:row.total,updatedLast24Hours:row.updated,
    ...(dayStart == null ? {} : {updatedToday:row.today}),
    nextBefore:row.next_before == null ? null : Number(row.next_before)};
}
export async function listOrderIssues(db: Database, filter: Filter, before?: unknown) {
  const f=currentOrderScope(filter);
  const boundary = before == null ? null : count(before, 1, Number.MAX_SAFE_INTEGER);
  const arg = f.params.length + 1;
  // Called explicitly for the review screen. The collector's frequent list and
  // identity polling never inspects lines from orders outside its display page.
  const row=(await db.query<{items:OrderCard[];total:number;next_before:string|null}>(`
 WITH visible AS (${visibleOrders(f)}), issues AS MATERIALIZED (
 SELECT s.* FROM visible s JOIN record_order_revisions v ON v.sequence=s.sequence WHERE ${firstIssue} IS NOT NULL),
 matches AS (SELECT * FROM issues WHERE ($${arg}::bigint IS NULL OR sequence<$${arg}) ORDER BY sequence DESC LIMIT 21),
 page AS (SELECT * FROM matches ORDER BY sequence DESC LIMIT 20)
 SELECT COALESCE((SELECT jsonb_agg(${card} ORDER BY p.sequence DESC) FROM page p
 JOIN record_order_revisions v ON v.sequence=p.sequence),'[]'::jsonb) items,
 (SELECT count(*)::integer FROM issues) total,
 CASE WHEN (SELECT count(*) FROM matches)>20 THEN (SELECT min(sequence) FROM page) END next_before`,[...f.params,boundary])).rows[0];
  return {orderIssues:row.items,orderIssueCount:row.total,nextIssuesBefore:row.next_before==null?null:Number(row.next_before)};
}
export async function readOrder(db: Database, f: Filter, id: string, revision?: unknown) {
  f = currentOrderScope(f);
  const j = f.params.length,
    v = revision === undefined ? null : count(revision, 1, 2147483647);
  const row = (await db.query<{
    view: unknown;
  }>(`SELECT v.view FROM record_order_roots r JOIN record_order_revisions v ON v.proof_id=r.proof_id WHERE ${f.where} AND r.proof_id=$${j + 1} AND ($${j + 2}::integer IS NULL OR v.revision=$${j + 2}) ORDER BY v.revision DESC LIMIT 1`, [...f.params, id, v])).rows[0];
  if (!row) throw new DomainError('PROOF_NOT_FOUND', 'This order revision could not be found in your workspace.', 404);
  return row.view;
}
