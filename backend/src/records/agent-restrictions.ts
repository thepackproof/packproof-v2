import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { PartnerActor, PartnerScope } from '../platform/organizations.js';
import type { CsvMapping, ShipmentCsvRow } from './csv.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';

/** A restriction belongs to the principal, so issuing another credential cannot
 * turn an installation principal into an unrestricted organization service. */
export interface AgentApprovedConfig {
  folderDigest: string;
  sourceName: string;
  integrationAccountId: string;
  operatorMembershipId: string;
  locationId: string | null;
  mapping: CsvMapping;
  timeZone: string;
  importValidRows: boolean;
  offlineWindowHours: number;
}
export interface AgentRestriction {
  id: string;
  organization_id: string;
  environment: 'sandbox' | 'live';
  principal_id: string;
  credential_id: string;
  integration_account_id: string;
  operator_membership_id: string;
  location_id: string | null;
  source_name: string;
  status: 'setup' | 'ready' | 'active' | 'paused' | 'revoked';
  config_revision: number;
  approved_config: AgentApprovedConfig | null;
  test_import_id: string | null;
  verified_import_id: string | null;
  enrollment_acknowledged_at: Date | string | null;
  enrollment_expires_at: Date | string;
  renewal_credential_id: string | null;
  renewal_expires_at: Date | string | null;
}
const limitedScopes: readonly PartnerScope[] = ['imports:read', 'imports:write', 'proofs:read', 'proofs:write'];
const unavailable = () => new DomainError('AGENT_AUTHORIZATION_REQUIRED', 'This installation needs current administrator approval.', 403);

export async function agentRestriction(db: Database, actor: PartnerActor): Promise<AgentRestriction | null> {
  // Worker roles have SELECT only. Authority-changing commands acquire this
  // same transaction lock before their row lock; no UPDATE privilege is needed.
  await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))', [actor.principalId]);
  return (await db.query<AgentRestriction>('SELECT * FROM record_agent_installations WHERE principal_id=$1', [actor.principalId])).rows[0] ?? null;
}
async function binding(db: Database, row: AgentRestriction, actor: PartnerActor, clock: Clock) {
  if (row.organization_id !== actor.merchantId || row.organization_id !== actor.principalOrganizationId || row.environment !== actor.environment || actor.delegationGrantId || actor.partnerOrganizationId || row.status === 'revoked') throw unavailable();
  const successor = row.renewal_credential_id === actor.credentialId;
  if (row.credential_id !== actor.credentialId && !successor) throw unavailable();
  if (!row.enrollment_acknowledged_at && new Date(row.enrollment_expires_at).getTime() <= clock.now().getTime()) throw unavailable();
  if (successor && (!row.renewal_expires_at || new Date(row.renewal_expires_at).getTime() <= clock.now().getTime())) throw unavailable();
  // Policy refresh authorizes further local source reads, not just HTTP writes.
  // A revoked teammate or location grant must therefore stop config/heartbeat
  // refresh as well as the import worker. This query requires SELECT only.
  const current = await db.query(`SELECT 1 FROM platform_integration_accounts a
    JOIN platform_memberships m ON m.id=$4 AND m.organization_id=a.merchant_id
    JOIN users u ON u.id=m.user_id
    WHERE a.id=$1 AND a.merchant_id=$2 AND a.environment=$3
      AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE'
      AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM record_locations l WHERE l.id=$5 AND l.organization_id=a.merchant_id))
      AND (m.location_scoped=false OR ($5::text IS NOT NULL AND EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=a.merchant_id AND g.location_id=$5)))`,
    [row.integration_account_id,row.organization_id,row.environment,row.operator_membership_id,row.location_id]);
  if (!current.rows[0]) throw unavailable();
}

/** Called by the common reauthorization path, including workers and cached
 * command responses. The narrower operation checks below still apply. */
export async function authorizeAgentScope(db: Database, clock: Clock, actor: PartnerActor, scope: PartnerScope) {
  const row = await agentRestriction(db, actor);
  if (!row) return;
  await binding(db, row, actor, clock);
  if (!limitedScopes.includes(scope)) throw new DomainError('AGENT_OPERATION_DENIED', 'This installation is restricted to its approved CSV connection.', 403);
}

/** Run before mounting any general partner routers. No scope string grants an
 * installation listing, sharing, capture, exports or event-stream access. */
export async function authorizeAgentRoute(db: Database, clock: Clock, actor: PartnerActor, method: string, path: string) {
  const row = await agentRestriction(db, actor);
  if (!row) return;
  await binding(db, row, actor, clock);
  const heartbeat = method === 'POST' && path === '/agent/heartbeat';
  const config = method === 'GET' && path === '/agent/config';
  const renewal = method === 'POST' && path === '/agent/credential-renewals';
  if (!row.enrollment_acknowledged_at && !heartbeat) throw unavailable();
  if (row.renewal_credential_id) {
    // After quiescence the old token can only recover the exact renewal; the
    // successor must be durably saved and acknowledged before data operations.
    if (actor.credentialId === row.credential_id ? !(config || renewal) : !(config || heartbeat)) throw unavailable();
    return;
  }
  const allowed = config || heartbeat || renewal ||
    (method === 'POST' && path === '/agent/config-proposals') ||
    (method === 'POST' && path === '/imports/preview') ||
    (method === 'GET' && /^\/imports\/[A-Za-z0-9_-]+$/.test(path)) ||
    (method === 'POST' && /^\/imports\/[A-Za-z0-9_-]+\/commit$/.test(path)) ||
    (method === 'GET' && /^\/proofs\/[A-Za-z0-9_-]+$/.test(path) && path !== '/proofs/resolve');
  if (!allowed) throw new DomainError('AGENT_OPERATION_DENIED', 'This installation is restricted to its approved CSV connection.', 403);
}

interface ImportIdentity {
  integrationAccountId: string;
  operatorMembershipId: string;
  sourceName: string;
  mapping: CsvMapping;
  timeZone: string;
}
function exactConfig(row: AgentRestriction, input: ImportIdentity) {
  const c = row.approved_config;
  return !!c && row.config_revision > 0 &&
    c.integrationAccountId === row.integration_account_id && c.operatorMembershipId === row.operator_membership_id && c.locationId === row.location_id && c.sourceName === row.source_name &&
    input.integrationAccountId === c.integrationAccountId && input.operatorMembershipId === c.operatorMembershipId && input.sourceName === c.sourceName && input.timeZone === c.timeZone && canonicalize(input.mapping) === canonicalize(c.mapping);
}
function rowLocations(row: AgentRestriction, mapping: CsvMapping, rows: readonly Pick<ShipmentCsvRow, 'values' | 'normalized'>[]) {
  for (const source of rows) {
    // Check even invalid business rows. A malformed quantity must not hide a
    // request to upload another location's data in the retained original.
    const location = mapping.locationId ? (source.values[mapping.locationId] ?? '').trim() || null : null;
    if (location !== row.location_id || (source.normalized && source.normalized.locationId !== row.location_id)) throw new DomainError('AGENT_LOCATION_DENIED', 'Every source row must identify the approved location.', 403);
  }
}
function dataCredential(row: AgentRestriction, actor: PartnerActor) {
  if (!row.enrollment_acknowledged_at || row.credential_id !== actor.credentialId || row.renewal_credential_id) throw unavailable();
}
export async function authorizeAgentPreview(db: Database, clock: Clock, actor: PartnerActor, input: ImportIdentity, rows: readonly Pick<ShipmentCsvRow, 'values' | 'normalized'>[]) {
  const row = await agentRestriction(db, actor);
  if (!row) return null;
  await binding(db, row, actor, clock); dataCredential(row, actor);
  if (!['ready', 'active'].includes(row.status) || !exactConfig(row, input)) throw unavailable();
  rowLocations(row, input.mapping, rows);
  return row;
}

export interface AgentImportIdentity {
  id: string;
  agent_installation_id: string | null;
  agent_config_revision: number | null;
  integration_account_id: string;
  operator_membership_id: string;
  source_name: string;
  mapping: CsvMapping;
  time_zone: string;
  import_valid_rows: boolean;
  state: string;
}
/** The receipt's original metadata must still match the current approved
 * revision. Reconfiguration cannot reuse an old successful setup receipt. */
export async function authorizeAgentImport(db: Database, clock: Clock, actor: PartnerActor, job: AgentImportIdentity, mode: 'read' | 'commit' | 'process', rows: readonly Pick<ShipmentCsvRow, 'values' | 'normalized'>[] = [], importValidRows?: boolean) {
  const row = await agentRestriction(db, actor);
  if (!row) return;
  await binding(db, row, actor, clock); dataCredential(row, actor);
  const identity = { integrationAccountId: job.integration_account_id, operatorMembershipId: job.operator_membership_id, sourceName: job.source_name, mapping: job.mapping, timeZone: job.time_zone };
  if (job.agent_installation_id !== row.id || job.agent_config_revision !== row.config_revision || !exactConfig(row, identity)) {
    if (mode === 'read') throw new DomainError('IMPORT_NOT_FOUND', 'Import not found', 404);
    throw unavailable();
  }
  rowLocations(row, job.mapping, rows);
  if (mode === 'read') return;
  if (row.status === 'setup' || row.status === 'revoked' || (row.status === 'paused' && mode !== 'process')) throw unavailable();
  const continuous = row.status === 'active' || (row.status === 'paused' && mode === 'process' && !!row.verified_import_id);
  if (!continuous && row.test_import_id !== job.id) throw new DomainError('AGENT_TEST_APPROVAL_REQUIRED', 'Approve this exact previewed batch in the browser before creating its records.', 403);
  const partial = importValidRows ?? job.import_valid_rows;
  if (partial !== row.approved_config!.importValidRows) throw new DomainError('AGENT_IMPORT_POLICY_CHANGED', 'Use the administrator-approved invalid-row policy.', 403);
}

export async function authorizeAgentProof(db: Database, clock: Clock, actor: PartnerActor, proofId: string) {
  const row = await agentRestriction(db, actor);
  if (!row) return;
  await binding(db, row, actor, clock); dataCredential(row, actor);
  if (!row.approved_config || row.config_revision < 1) throw new DomainError('PROOF_NOT_FOUND', 'Proof not found', 404);
  const source = await db.query(`SELECT 1 FROM platform_external_bindings b JOIN platform_proof_ownership p ON p.proof_id=b.proof_id JOIN record_state r ON r.proof_id=b.proof_id
    WHERE b.proof_id=$1 AND b.merchant_id=$2 AND b.environment=$3 AND b.integration_account_id=$4 AND b.resource_type='SHIPMENT' AND p.operator_membership_id=$5 AND r.location_id IS NOT DISTINCT FROM $6`,
    [proofId, actor.merchantId, actor.environment, row.integration_account_id, row.operator_membership_id, row.location_id]);
  if (!source.rows[0]) throw new DomainError('PROOF_NOT_FOUND', 'Proof not found', 404);
}
