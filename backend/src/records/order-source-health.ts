import express from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { strictBody, type PartnerActor } from '../platform/organizations.js';
import { requireRecordWorkspace, type RecordWorkspace } from './access.js';
import { currentOrderScope, humanOrderFilter } from './order-feed.js';
import { activeScope, checkedInstallation, boundedText, digest, positive } from './order-workspace.js';
import { humanAttentionFilter } from './order-review.js';
import { facilityEnabled } from './facility-flags.js';
import { cartonStates } from './order-subjects.js';

function instant(value: unknown, now: Date) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || Date.parse(value) > now.getTime() + 60000)
    throw new DomainError('INVALID_SOURCE_TIME','Check the collector clock before reporting source health.',400);
  return new Date(value).toISOString();
}
export function orderHealthAgentRouter(deps: AppDependencies) {
  const router = express.Router();
  router.post('/agent/order-workspace/source-health',async (req,res,next) => {
    try {
      const actor = (req as typeof req & {partnerActor:PartnerActor}).partnerActor;
      const body = strictBody(req.body,['scopeDigest','sourceId','generation','state','lastVerifiedReadAt','checkedAt']);
      const now = deps.clock.now(), checked = instant(body.checkedAt,now);
      const verified = body.lastVerifiedReadAt == null ? null : instant(body.lastVerifiedReadAt,now);
      if (!['current','unreadable'].includes(String(body.state)) || (body.state === 'current' && !verified) || (verified && verified > checked))
        throw new DomainError('INVALID_SOURCE_TIME','Report the last successful read separately from the latest check.',400);
      await deps.db.transaction(async tx => {
        const install = await checkedInstallation(tx,deps.clock,actor,true);
        const grant = await activeScope(tx,install,digest(body.scopeDigest));
        const id = boundedText(body.sourceId,'source'), generation = positive(body.generation);
        if (!facilityEnabled('guided',install.organization_id,install.environment,install.location_id) ||
            !grant.scope.testedProfile || !grant.scope.sources.some(s => s.id === id && s.generation === generation && s.transport === 'folder'))
          throw new DomainError('AUTH_REQUIRED','Approve this source generation before reporting health.',403);
        await tx.query(`INSERT INTO record_order_source_health(session_id,source_id,generation,checked_at,verified_read_at,received_at,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,source_id,generation) DO UPDATE SET
          checked_at=EXCLUDED.checked_at,verified_read_at=GREATEST(record_order_source_health.verified_read_at,EXCLUDED.verified_read_at),
          received_at=EXCLUDED.received_at,state=EXCLUDED.state WHERE EXCLUDED.checked_at>record_order_source_health.checked_at`,
          [grant.id,id,generation,checked,verified,now,body.state]);
      });
      res.set('Cache-Control','private, no-store').json({accepted:true});
    } catch (error) {next(error);}
  });
  return router;
}
type Approved = {id:string;displayName?:string;generation:number;expectedCheckIntervalSeconds?:number;expectedDeliveryAfterLabelSeconds?:number;roles:string[]};
type Health = {source:Approved;sole_delivery_source:boolean;installation_id:string;session_id:string;state:string|null;verified_read_at:Date|string|null;decided_at:Date|string;organization_id:string;environment:string;location_id:string|null};
type Events = Parameters<typeof cartonStates>[0];
type Order = {proofId:string;orderReference:string;events:Events;eligibleKeys:string[]};
export function sourceCondition(row: Pick<Health,'source'|'state'|'verified_read_at'|'decided_at'>, asOf: Date) {
  const cadence = row.source.expectedCheckIntervalSeconds;
  const last = row.verified_read_at ? new Date(row.verified_read_at).toISOString() : null;
  const nextCheckAt = cadence ? new Date(Date.parse(last ?? new Date(row.decided_at).toISOString()) + cadence*1000).toISOString() : null;
  const state = row.state === 'unreadable' ? 'unreadable' : nextCheckAt && Date.parse(nextCheckAt) < asOf.getTime() ? 'delayed' : last ? 'current' : 'pending';
  return {state,lastVerifiedReadAt:last,nextCheckAt};
}
export function overdueCartons(source:Approved, events:Events, now:Date) {
  if (!source.expectedDeliveryAfterLabelSeconds || !source.expectedCheckIntervalSeconds || !source.roles.includes('delivery')) return [];
  const labels = new Map<string,number>();
  for (const event of events) {
    if (event.kind !== 'label' || !event.occurredAt || event.associationScope !== 'order') continue;
    for (const ref of [event.entity,...event.references]) {
      if (ref.type !== 'package') continue;
      const key = JSON.stringify([ref.namespace,ref.id]), time = Date.parse(event.occurredAt);
      if (Number.isFinite(time)) labels.set(key,Math.min(labels.get(key) ?? Infinity,time));
    }
  }
  return cartonStates(events).flatMap(carton => {
    const label = labels.get(JSON.stringify([carton.namespace,carton.id]));
    if (carton.deliveryStatus === 'delivered' || label === undefined) return [];
    const deadline = new Date(label + source.expectedDeliveryAfterLabelSeconds! * 1000);
    return deadline < now ? [{id:carton.id,namespace:carton.namespace,deadline:deadline.toISOString()}] : [];
  });
}
export async function readSourceHealth(db:Database, clock:Clock, w:RecordWorkspace, location:unknown) {
  const f = await humanAttentionFilter(db,w,location);
  const scope = currentOrderScope(await humanOrderFilter(db,w,location));
  const now = clock.now();
  const sources = (await db.query<Health>(`SELECT s.id session_id,i.id installation_id,i.organization_id,i.environment,i.location_id,s.decided_at,
    src AS source,h.state,h.verified_read_at,(SELECT count(*)=1 FROM jsonb_array_elements(s.scope->'sources') d WHERE d->'roles' ? 'delivery') AS sole_delivery_source
    FROM record_agent_installations i JOIN record_order_sessions s
    ON s.installation_id=i.id AND s.state='active' CROSS JOIN LATERAL jsonb_array_elements(s.scope->'sources') src
    LEFT JOIN record_order_source_health h ON h.session_id=s.id AND h.source_id=src->>'id' AND h.generation=(src->>'generation')::int
    WHERE ${f.where} AND s.scope ? 'testedProfile' AND i.status NOT IN ('paused','revoked') AND src->>'transport'='folder'
    ORDER BY i.id,src->>'id' LIMIT 201`,f.params)).rows;
  const incidents = [], overdue = [];
  let limited = sources.length > 200;
  for (const row of sources.slice(0,200)) {
    if (!facilityEnabled('guided',row.organization_id,row.environment,row.location_id)) continue;
    const source = row.source, condition = sourceCondition(row,now);
    const incident = condition.state === 'unreadable' || condition.state === 'delayed';
    if (!incident && !(condition.state === 'current' && source.expectedDeliveryAfterLabelSeconds && source.roles.includes('delivery'))) continue;
    // A label in this approval can start the deadline when only one delivery feed covers it.
    // With multiple delivery feeds, attribute a carton only through a direct report from this source.
    const n = scope.params.length;
    const includeLabels = row.sole_delivery_source && source.roles.includes('delivery') && !!source.expectedDeliveryAfterLabelSeconds;
    const orders = (await db.query<Order>(`SELECT r.proof_id "proofId",r.order_reference "orderReference",v.view->'events' events, linked.keys "eligibleKeys"
      FROM record_order_roots r JOIN LATERAL (SELECT view FROM record_order_revisions v WHERE v.proof_id=r.proof_id ORDER BY revision DESC LIMIT 1) v ON true
      JOIN LATERAL (SELECT array_agg(e->>'eventKey') keys FROM jsonb_array_elements(v.view->'events') e
        JOIN record_order_receipts b ON b.id=e->>'receiptId' JOIN record_order_sessions old ON old.id=b.session_id
        WHERE e->>'associationScope'='order' AND old.installation_id=$${n+1} AND b.operation_key=r.operation_key AND
          ((b.source_id=$${n+2} AND b.generation=$${n+3}) OR ($${n+4} AND b.session_id=$${n+5} AND e->>'kind'='label'))
        HAVING count(*)>0) linked ON true
      WHERE ${scope.where} ORDER BY r.proof_id LIMIT 51`,[...scope.params,row.installation_id,source.id,source.generation,includeLabels,row.session_id])).rows;
    limited ||= orders.length > 50;
    const visible = orders.slice(0,50);
    if (incident) incidents.push({installationId:row.installation_id,sourceId:source.id,generation:source.generation,
      displayName:source.displayName || source.roles.join(', '),...condition,
      affectedOrders:visible.map(({proofId,orderReference}) => ({proofId,orderReference}))});
    else for (const order of visible) {
      const eligibleKeys = new Set(order.eligibleKeys);
      const linked = new Set(order.events.filter(e => eligibleKeys.has(e.eventKey))
        .flatMap(e => [e.entity,...e.references].filter(r => r.type === 'package').map(r => JSON.stringify([r.namespace,r.id]))));
      for (const carton of overdueCartons(source,order.events,now)) if (linked.has(JSON.stringify([carton.namespace,carton.id])))
        overdue.push({proofId:order.proofId,orderReference:order.orderReference,...carton});
    }
  }
  return {asOf:now.toISOString(),incidents,overdue,limited};
}
export function orderHealthHumanRouter(deps: AppDependencies) {
  const router = express.Router();
  router.get('/order-source-health',async (req,res,next) => {
    try {
      const actor = await deps.auth.authenticate(req.headers);
      const result = await deps.db.transaction(async tx => readSourceHealth(tx,deps.clock,
        await requireRecordWorkspace(tx,actor.userId,req.query.organizationId,req.query.environment),req.query.locationId));
      res.set('Cache-Control','private, no-store').json(result);
    } catch(error) {next(error);}
  });
  return router;
}
