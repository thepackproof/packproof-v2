import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { newId } from '../ids.js';
import { importPartnerOrder } from '../platform/partner-proofs.js';
import { strictBody, type PartnerActor } from '../platform/organizations.js';
import { orderApiPaused } from './order-api-history.js';
import { activeScope, boundedText, digest, positive } from './order-workspace.js';
import { loadInstallation } from './agent-enrollments.js';
import { preserveOrderOriginal, ensureOrderRoot, insertOrderEvent, orderComponent, lockOperation, commitOrderGroup, originFor, ingestOrderFile } from './order-ledger.js';
import { normalizedRecord, refKey } from './order-projection.js';
import { reconstructionFeatureEnabled } from './reconstruction-features.js';
type Bind = {
  installationId: string;
  scopeDigest: string;
  sourceId: string;
  generation: number;
};
function parseBinding(input: unknown): Bind {
  const b = strictBody(input, ['installationId', 'scopeDigest', 'sourceId', 'generation']);
  return {
    installationId: boundedText(b.installationId, 'installation'),
    scopeDigest: digest(b.scopeDigest),
    sourceId: boundedText(b.sourceId, 'source'),
    generation: positive(b.generation)
  };
}
async function cloudBinding(db: Database, a: PartnerActor, account: string, operator: string, binding: Bind | null) {
  if (a.delegationGrantId || a.partnerOrganizationId || a.principalOrganizationId !== a.merchantId) {
    if (binding) throw new DomainError('AUTH_REQUIRED', 'This order source requires direct merchant authorization.', 403);
    return null;
  }
  let chosen = binding;
  if (!chosen) {
    // An unqualified call cannot cross a location boundary. Only select an exact,
    // active location-free source when all four existing authority keys agree.
    const hits = (await db.query<{
      id: string;
      scope_digest: string;
      source_id: string;
      generation: number;
    }>(`SELECT i.id,s.scope_digest,source->>'id' source_id,(source->>'generation')::integer generation
   FROM record_agent_installations i JOIN record_order_sessions s ON s.installation_id=i.id AND s.state='active'
   CROSS JOIN LATERAL jsonb_array_elements(s.scope->'sources') source
   WHERE i.organization_id=$1 AND i.environment=$2 AND i.integration_account_id=$3 AND i.operator_membership_id=$4 AND i.location_id IS NULL
    AND i.status NOT IN ('revoked','paused') AND i.enrollment_acknowledged_at IS NOT NULL AND source->>'transport'='api' AND source->'roles' ? 'order' LIMIT 2`, [a.merchantId, a.environment, account, operator])).rows;
    if (hits.length !== 1) return null;
    chosen = {
      installationId: hits[0].id,
      scopeDigest: hits[0].scope_digest,
      sourceId: hits[0].source_id,
      generation: hits[0].generation
    };
  }
  const i = await loadInstallation(db, chosen.installationId, true);
  if (i.organization_id !== a.merchantId || i.environment !== a.environment || i.integration_account_id !== account || i.operator_membership_id !== operator || !i.enrollment_acknowledged_at || ['revoked', 'paused'].includes(i.status)) throw new DomainError('AUTH_REQUIRED', 'This order does not belong to the selected installation scope.', 403);
  const valid = (await db.query(`SELECT 1 FROM platform_memberships m JOIN users u ON u.id=m.user_id
  WHERE m.id=$1 AND m.organization_id=$2 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE'
  AND (NOT m.location_scoped OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=$3))`, [operator, i.organization_id, i.location_id])).rows[0];
  if (!valid) throw new DomainError('AUTH_REQUIRED', 'The operator no longer has access to this source location.', 403);
  const session = await activeScope(db, i, chosen.scopeDigest);
  const source = session.scope.sources.find(s => s.id === chosen!.sourceId && s.generation === chosen!.generation && s.transport === 'api' && s.roles.includes('order') && s.sourceNamespace);
  if (!source) throw new DomainError('AUTH_REQUIRED', 'Approve this API source and order namespace before submitting records.', 403);
  if (await orderApiPaused(db, i, source)) throw new DomainError('CONNECTION_PAUSED', 'Resume this order source before submitting new records.', 409);
  return {
    i,
    session,
    source
  };
}
/** Keep the canonical Proof created by the public order import. Only an active
 * approved API source can publish the exact submission to a Connect operation. */
export async function importCloudOrder(deps: AppDependencies, tx: Database, a: PartnerActor, input: unknown, bytes: Buffer | undefined) {
  const raw = input as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return importPartnerOrder(tx, deps.clock, a, input);
  const {
    connectOperation,
    orderLines,
    ...body
  } = raw;
  if (!reconstructionFeatureEnabled('orderWorkspace')) {
    if (connectOperation !== undefined || orderLines !== undefined) throw new DomainError('AUTH_REQUIRED', 'This operation has not enabled connected orders.', 409);
    return importPartnerOrder(tx, deps.clock, a, input);
  }
  if (typeof body.integrationAccountId !== 'string' || typeof body.operatorMembershipId !== 'string' || typeof body.externalId !== 'string') return importPartnerOrder(tx, deps.clock, a, input);
  const approved = await cloudBinding(tx, a, body.integrationAccountId, body.operatorMembershipId, connectOperation === undefined ? null : parseBinding(connectOperation));
  if (!approved) {
    if (orderLines !== undefined) throw new DomainError('AUTH_REQUIRED', 'An approved order source is required for line allocations.', 403);
    return importPartnerOrder(tx, deps.clock, a, body);
  }
  const {
      i,
      session,
      source
    } = approved,
    o = originFor(i);
  await lockOperation(tx, o.operation);
  const result = await importPartnerOrder(tx, deps.clock, a, body);
  if (!result.created) return result;
  if (!bytes) throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED', 'The original order submission could not be retained. Retry the submission.', 503);
  const sha = sha256Hex(bytes),
    stored = await preserveOrderOriginal(deps, o.organization, sha, bytes, 'application/json');
  const transaction = body.transaction as Record<string, unknown>,
    fields: Record<string, string> = {};
  if (typeof transaction.itemTitle === 'string') fields.itemTitle = transaction.itemTitle;
  if (transaction.quantity !== undefined) fields.quantity = String(transaction.quantity);
  const record = normalizedRecord({
    eventId: result.proofId,
    version: '1',
    kind: 'order',
    facilityId: i.location_id,
    entity: {
      namespace: source.sourceNamespace,
      type: 'order',
      id: body.externalId
    },
    references: [],
    fields,
    lines: orderLines ?? [],
    locator: '$.transaction'
  });
  const id = newId('order_receipt'),
    now = deps.clock.now().toISOString();
  await tx.query(`INSERT INTO record_order_receipts(id,operation_key,source_id,generation,observation_id,payload_digest,original_sha256,object_key,object_version,file_name,media_type,profile_version,issues,received_at,session_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'order.json','application/json',$10,'[]'::jsonb,$11,$12)`, [id, o.operation, source.id, source.generation, result.proofId, sha256Hex(canonicalize(body)), sha, stored.key, stored.version, source.profileVersion, now, session.id]);
  await ensureOrderRoot(tx, deps.clock, a, o, source.id, record, result.proofId);
  await insertOrderEvent(tx, o.operation, source.id, id, record);
  const group = await orderComponent(tx, o.operation, [refKey(record.entity)]);
  await commitOrderGroup(tx, deps.clock, o.operation, group, a.actorUserId);
  return {
    ...result,
    connectedOrder: true,
    connectedEventId: result.proofId
  };
}

/** Authenticated push adapter. Replays and corrections use the same grant,
 * durable original store, canonical order identities and event processor as
 * collection from an approved folder. */
export async function submitCloudEvents(deps: AppDependencies, db: Database, a: PartnerActor, input: unknown) {
  if (!reconstructionFeatureEnabled('orderWorkspace')) throw new DomainError('AUTH_REQUIRED', 'Connected order intake has not been enabled.', 409);
  const b = strictBody(input, ['integrationAccountId', 'operatorMembershipId', 'connectOperation', 'observation']);
  const chosen = parseBinding(b.connectOperation),
    account = boundedText(b.integrationAccountId, 'integration account'),
    operator = boundedText(b.operatorMembershipId, 'operator');
  const approved = await cloudBinding(db, a, account, operator, chosen);
  if (!approved) throw new DomainError('AUTH_REQUIRED', 'An approved API order source is required.', 403);
  const item = strictBody(b.observation, ['observationId', 'fileName', 'mediaType', 'originalSha256', 'originalBase64', 'records', 'issues']);
  return ingestOrderFile(deps, db, a, approved.i, {
    ...item,
    scopeDigest: chosen.scopeDigest,
    sourceId: chosen.sourceId,
    generation: chosen.generation,
    profileVersion: approved.source.profileVersion
  }, 'api');
}
