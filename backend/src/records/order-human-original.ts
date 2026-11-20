import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { auditOrganization, strictBody } from '../platform/organizations.js';
import { requireRecordLocation, type RecordWorkspace } from './access.js';
import { loadInstallation, type Installation } from './agent-enrollments.js';
import { humanOrderFilter, readOrder } from './order-feed.js';
import { readOrderArtifact } from './order-artifact.js';
import { readOrderSource } from './order-source.js';
import { boundedText } from './order-workspace.js';

export async function humanOrderOriginal(deps: AppDependencies, db: Database, w: RecordWorkspace,
  proofId: string, revision: string, kind: 'source' | 'artifact', key: string, locationId?: unknown) {
  const proof = await readOrder(db, await humanOrderFilter(db, w, locationId), proofId, revision) as {
    evidence: {eventKey: string; receiptId: string}[]; originalArtifacts?: {receiptId: string}[];
  };
  const receipt = kind === 'source' ? proof.evidence.find(e => e.eventKey === key)
    : proof.originalArtifacts?.find(e => e.receiptId === key);
  if (!receipt) throw new DomainError('SOURCE_NOT_FOUND','This item is unavailable in the selected revision.',404);
  const i = (await db.query<Installation>(`SELECT i.* FROM record_order_receipts r
    JOIN record_order_sessions s ON s.id=r.session_id JOIN record_agent_installations i ON i.id=s.installation_id
    JOIN platform_principals p ON p.id=i.principal_id AND p.organization_id=i.organization_id AND p.revoked_at IS NULL
    JOIN platform_credentials c ON c.id=i.credential_id AND c.principal_id=i.principal_id AND c.revoked_at IS NULL
    LEFT JOIN record_order_original_access g ON g.installation_id=i.id AND g.membership_id=$2
    WHERE r.id=$1 AND i.organization_id=$3 AND i.environment=$4 AND i.status NOT IN ('paused','revoked')
    AND i.enrollment_acknowledged_at IS NOT NULL AND c.expires_at>$5 AND COALESCE(g.allowed,$6)
    FOR SHARE OF i,p,c`, [receipt.receiptId,w.membershipId,w.organizationId,w.environment,deps.clock.now(),
      w.role === 'OWNER' || w.role === 'ADMIN'])).rows[0];
  if (!i) throw new DomainError('ORIGINAL_ACCESS_DENIED','Your current access permits the order summary only.',403);
  await requireRecordLocation(db,w,i.location_id);
  return kind === 'source' ? readOrderSource(deps,db,i,proofId,revision,key)
    : readOrderArtifact(deps,db,i,proofId,revision,key);
}

export async function setOriginalAccess(deps: AppDependencies, db: Database, w: RecordWorkspace,
  installationId: string, input: unknown) {
  const b = strictBody(input,['organizationId','environment','membershipId','allowed','reason']);
  const membershipId = boundedText(b.membershipId,'workspace member');
  const reason = boundedText(b.reason,'reason',512);
  if (!['OWNER','ADMIN'].includes(w.role) || typeof b.allowed !== 'boolean')
    throw new DomainError('ORIGINAL_ACCESS_DENIED','An administrator must set original access.',403);
  const i = await loadInstallation(db,installationId,true);
  if (i.organization_id !== w.organizationId || i.environment !== w.environment)
    throw new DomainError('INSTALLATION_NOT_FOUND','This installation is unavailable.',404);
  await requireRecordLocation(db,w,i.location_id);
  const member = (await db.query(`SELECT 1 FROM platform_memberships m WHERE m.id=$1 AND m.organization_id=$2
    AND m.revoked_at IS NULL AND (NOT m.location_scoped OR EXISTS (SELECT 1 FROM record_membership_locations l
    WHERE l.membership_id=m.id AND l.organization_id=m.organization_id AND l.location_id=$3)) FOR SHARE OF m`,
    [membershipId,w.organizationId,i.location_id])).rows[0];
  if (!member) throw new DomainError('MEMBER_NOT_FOUND','Choose a current member assigned to this location.',404);
  await db.query(`INSERT INTO record_order_original_access(installation_id,membership_id,allowed,reason,decided_by,decided_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id,membership_id) DO UPDATE SET allowed=EXCLUDED.allowed,
    reason=EXCLUDED.reason,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at`,
    [i.id,membershipId,b.allowed,reason,w.userId,deps.clock.now()]);
  await auditOrganization(db,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId:membershipId,
    operation:b.allowed ? 'ORDER_ORIGINAL_ACCESS_GRANTED' : 'ORDER_ORIGINAL_ACCESS_REVOKED',resourceId:i.id});
  return {installationId:i.id,membershipId,allowed:b.allowed};
}
