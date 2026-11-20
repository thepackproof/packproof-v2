import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { idempotent } from '../platform/idempotency.js';
import { strictBody } from '../platform/organizations.js';
import type { RecordWorkspace } from './access.js';
import { humanOrderFilter, readOrder } from './order-feed.js';
import { boundedText, positive } from './order-workspace.js';

const columns = `id,case_key AS "caseKey",version,proof_revision AS "proofRevision",action,
  owner_membership_id AS "ownerMembershipId",actor_user_id AS "actorUserId",reason,created_at AS "createdAt"`;
type Filter = Awaited<ReturnType<typeof humanOrderFilter>>;

export async function listCaseActions(tx: Database, filter: Filter, proofId: string) {
  await readOrder(tx,filter,proofId);
  return {items:(await tx.query(`SELECT ${columns} FROM record_order_case_actions WHERE proof_id=$1
    ORDER BY created_at DESC,id DESC LIMIT 100`,[proofId])).rows};
}

export async function caseAction(db: Database, clock: Clock, w: RecordWorkspace, proofId: string, input: unknown, key: unknown) {
  const body = strictBody(input,['organizationId','environment','caseKey','expectedVersion','expectedRevision','action','reason','ownerMembershipId']);
  const caseKey = boundedText(body.caseKey,'case',512), reason = boundedText(body.reason,'reason',1024);
  const revision = positive(body.expectedRevision), version = body.expectedVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version >= 2147483647)
    throw new DomainError('INVALID_REQUEST','Provide the last reviewed case version.',400);
  const action = boundedText(body.action,'action');
  if (!['assign','request_receipt','clarify_mapping','resolve'].includes(action))
    throw new DomainError('INVALID_REQUEST','Choose a supported review action.',400);
  const owner = body.ownerMembershipId == null ? null : boundedText(body.ownerMembershipId,'owner');
  if (action === 'assign' && !owner) throw new DomainError('INVALID_REQUEST','Select a case owner.',400);
  const filter = await humanOrderFilter(db,w);
  const result = await idempotent(db,clock,w.tenantId,'order-case:'+w.membershipId+':'+proofId,key,input,async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1347438181,0)');
    const view = await readOrder(tx,filter,proofId) as {revision:number;conflicts:string[];
      lines:Array<Record<string,unknown>>;cartons:Array<{namespace:string;id:string;deliveryStatus:string}>};
    if (view.revision !== revision) throw new DomainError('REVISION_CONFLICT','Review the current proof revision.',409);
    const last = (await tx.query<{version:number;owner:string|null}>(`SELECT version,owner_membership_id AS owner
      FROM record_order_case_actions WHERE proof_id=$1 AND case_key=$2 ORDER BY version DESC LIMIT 1`,[proofId,caseKey])).rows[0];
    if ((last?.version ?? 0) !== version) throw new DomainError('REVISION_CONFLICT','Refresh the case before saving.',409);
    const hasGap = caseKey === 'order' ? view.conflicts.length > 0 || view.lines.some(l =>
      l.loadedAcknowledgedDiscrepancy || l.orderedShippedDiscrepancy) : view.cartons.some(c =>
      'carton:'+c.namespace+':'+c.id === caseKey && c.deliveryStatus === 'awaiting_evidence');
    if (action === 'resolve' ? hasGap || !last : !hasGap)
      throw new DomainError('CASE_STATE_CHANGED','Review the remaining evidence gap before taking this action.',409);
    if (owner) {
      const allowed = (await tx.query(`SELECT 1 FROM platform_memberships m JOIN record_order_roots r ON r.proof_id=$1
        WHERE m.id=$2 AND m.organization_id=r.organization_id AND m.revoked_at IS NULL
        AND (m.role<>'OPERATOR' OR r.operator_membership_id=m.id) AND (NOT m.location_scoped OR EXISTS (
          SELECT 1 FROM record_membership_locations l WHERE l.membership_id=m.id AND l.organization_id=m.organization_id
          AND l.location_id=r.location_id)) FOR SHARE OF m`,[proofId,owner])).rows[0];
      if (!allowed) throw new DomainError('MEMBER_NOT_FOUND','Choose a current member who can see this order.',404);
    }
    const inserted = await tx.query(`INSERT INTO record_order_case_actions(id,proof_id,case_key,version,proof_revision,
      action,owner_membership_id,actor_user_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING ${columns}`,[newId('order_case'),proofId,caseKey,version+1,revision,action,owner ?? last?.owner ?? null,
      w.userId,reason,clock.now()]);
    return inserted.rows[0];
  });
  return result.value;
}
