import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { reauthorizePartner, strictBody, type PartnerActor } from '../platform/organizations.js';
import { installationForActor, loadInstallation, type Installation } from './agent-enrollments.js';
import { requireRecordLocation, type RecordWorkspace } from './access.js';
import { requireReconstructionFeature } from './reconstruction-features.js';
import { facilityEnabled } from './facility-flags.js';
export function boundedText(v: unknown, label: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new DomainError('INVALID_REQUEST', `Check ${label} and try again.`, 400);
  return v;
}
export function digest(v: unknown) {
  const s = boundedText(v, 'hash', 64);
  if (!/^[0-9a-f]{64}$/.test(s)) throw new DomainError('INVALID_REQUEST', 'A SHA-256 digest is required.', 400);
  return s;
}
export function positive(v: unknown) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > 2147483647) throw new DomainError('INVALID_REQUEST', 'A positive source generation is required.', 400);
  return v;
}
const roles = ['order', 'picking', 'packing', 'evidence', 'shipping', 'handoff', 'delivery', 'returns'];
interface ApprovedSource {
  id: string;
  generation: number;
  folderDigest: string;
  roles: string[];
  profileVersion: string;
  displayName?: string;
  transport: 'folder' | 'api';
  sourceNamespace?: string;
  expectedCheckIntervalSeconds?: number;
  expectedDeliveryAfterLabelSeconds?: number;
}
function parseSource(v: unknown): ApprovedSource {
  const s = strictBody(v, ['id', 'generation', 'folderDigest', 'roles', 'profileVersion', 'displayName', 'transport', 'sourceNamespace','expectedCheckIntervalSeconds','expectedDeliveryAfterLabelSeconds']);
  if (!Array.isArray(s.roles) || !s.roles.length || s.roles.length > roles.length || s.roles.some(r => !roles.includes(r))) throw new DomainError('INVALID_REQUEST', 'Choose the records supplied by each source.', 400);
  if (s.transport !== undefined && !['folder', 'api'].includes(String(s.transport))) throw new DomainError('INVALID_SCOPE', 'Choose a supported source transport.', 400);
  const direct = s.transport === 'api';
  const interval = s.expectedCheckIntervalSeconds === undefined ? undefined : positive(s.expectedCheckIntervalSeconds);
  const deadline = s.expectedDeliveryAfterLabelSeconds === undefined ? undefined : positive(s.expectedDeliveryAfterLabelSeconds);
  if (interval !== undefined && (interval < 60 || interval > 86400) || deadline !== undefined &&
      (deadline < 60 || deadline > 31536000 || !s.roles.includes('delivery')))
    throw new DomainError('INVALID_SCOPE','Check the source timing and delivery role.',400);
  if (direct && !s.roles.includes('order')) throw new DomainError('INVALID_SCOPE', 'Direct order intake requires the order role.', 400);
  return {
    ...(direct ? {
      transport: 'api',
      sourceNamespace: boundedText(s.sourceNamespace, 'system namespace')
    } : {
      transport: 'folder'
    }),
    id: boundedText(s.id, 'source'),
    ...(interval !== undefined ? {expectedCheckIntervalSeconds: interval} : {}),
    ...(deadline !== undefined ? {expectedDeliveryAfterLabelSeconds: deadline} : {}),
    generation: positive(s.generation),
    folderDigest: digest(s.folderDigest),
    roles: [...new Set<string>(s.roles)].sort(),
    profileVersion: boundedText(s.profileVersion, 'profile'),
    ...(s.displayName ? {
      displayName: boundedText(s.displayName, 'source name', 1024)
    } : {})
  };
}
function parseTestedProfile(input: unknown) {
  const p = strictBody(input, ['schema','digest','draftId','revision','examples']);
  const draftId = boundedText(p.draftId, 'draft ID', 36);
  if (p.schema !== 'packproof.facility-replay/v1' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(draftId) || p.examples !== 3)
    throw new DomainError('INVALID_SCOPE', 'Test the ordinary, split and reprinted-label orders with the current draft.', 400);
  return {schema: 'packproof.facility-replay/v1', digest: digest(p.digest), draftId, revision: positive(p.revision), examples: 3};
}
function parseScope(v: unknown) {
  const s = strictBody(v, ['sources', 'outputDigest', 'outputName', 'history','testedProfile']);
  if (s.history !== 'existing_and_future' || !Array.isArray(s.sources) || !s.sources.length || s.sources.length > 64) throw new DomainError('INVALID_SCOPE', 'Choose at least one source and review the history to include.', 400);
  const sources = s.sources.map(parseSource).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(sources.map(x => x.id)).size !== sources.length || new Set(sources.map(x => x.folderDigest)).size !== sources.length) throw new DomainError('INVALID_SCOPE', 'Assign each location once, with all applicable roles.', 400);
  return {
    sources,
    ...(s.testedProfile === undefined ? {} : {testedProfile: parseTestedProfile(s.testedProfile)}),
    history: 'existing_and_future',
    outputDigest: digest(s.outputDigest),
    ...(s.outputName ? {
      outputName: boundedText(s.outputName, 'destination name', 1024)
    } : {})
  };
}
export type OrderScope = ReturnType<typeof parseScope>;
interface Session {
  id: string;
  installation_id: string;
  scope_digest: string;
  scope: OrderScope;
  state: 'active' | 'pending' | 'denied' | 'superseded';
  expires_at: string | Date;
  decided_at?:string|Date|null;
  decided_by?:string|null;
}
export function operationKey(organization: string, environment: string, operator: string, account: string, location: string | null) {
  return sha256Hex(canonicalize(['order-operation/v1', organization, environment, operator, account, location]));
}
export function installationOperation(i: Installation) {
  return operationKey(i.organization_id, i.environment, i.operator_membership_id, i.integration_account_id, i.location_id);
}
export async function checkedInstallation(db: Database, clock: Clock, a: PartnerActor, write = false) {
  requireReconstructionFeature('orderWorkspace');
  await reauthorizePartner(db, clock, a, write ? 'imports:write' : 'imports:read');
  const i = await installationForActor(db, a, true);
  if (!i.enrollment_acknowledged_at || i.credential_id !== a.credentialId || i.renewal_credential_id || i.status === 'revoked' || i.status === 'paused' || a.delegationGrantId) throw new DomainError('AUTH_REQUIRED', 'Reconnect or resume this computer before continuing.', 403);
  return i;
}
function present(clock: Clock, i: Installation, s: Session | undefined) {
  if (!s) return {
    state: 'draft',
    scopeDigest: null,
    approvalPath: null,
    deviceName: i.device_name,
    offlineWindowSeconds: 0
  };
  const paused = (s.state === 'active' || s.state === 'pending') && s.scope.testedProfile &&
    !facilityEnabled('guided',i.organization_id,i.environment,i.location_id);
  const state = paused ? 'paused' : s.state === 'pending' && new Date(s.expires_at) <= clock.now() ? 'expired' : s.state;
  const query = new URLSearchParams({
    workspaceSession: s.id,
    installationId: i.id,
    organizationId: i.organization_id,
    environment: i.environment
  });
  return {
    id: s.id,
    state,
    scopeDigest: s.scope_digest,
    scope: s.scope,
    ...(state==='active' && s.decided_at && s.decided_by ? {approvedAt:new Date(s.decided_at).toISOString(),approvedBy:s.decided_by}:{}),
    expiresAt: new Date(s.expires_at).toISOString(),
    deviceName: i.device_name,
    approvalPath: state === 'pending' ? '/app/records/connect/approve?' + query.toString() : null,
    offlineWindowSeconds: state === 'active' ? 3600 : 0
  };
}
export async function workspaceState(db: Database, clock: Clock, i: Installation, expected?: unknown) {
  const params = expected===undefined ? [i.id] : [i.id,digest(expected)];
  const byScope = expected===undefined ? '' : ' AND scope_digest=$2';
  const result = await db.query<Session>("SELECT * FROM record_order_sessions WHERE installation_id=$1"+byScope+" ORDER BY (state='pending') DESC,created_at DESC,(state='active') DESC,id DESC LIMIT 1", params);
  return present(clock, i, result.rows[0]);
}
async function requireCurrentGenerations(db: Database, installationId: string, proposed: OrderScope) {
  const current=(await db.query<Session>("SELECT * FROM record_order_sessions WHERE installation_id=$1 AND state='active' FOR SHARE",[installationId])).rows[0];
  if (!current || !proposed.testedProfile && !current.scope.testedProfile) return;
  for (const source of proposed.sources) {
    const previous=current.scope.sources.find(s=>s.id===source.id);
    if (!previous) continue;
    // Display labels may change without reinterpreting the source. Readers, transport,
    // folder identity, roles, namespaces and timing govern the configuration itself.
    const {displayName: oldName,...oldConfig}=previous;
    const {displayName: newName,...newConfig}=source;
    if (source.generation < previous.generation || source.generation === previous.generation && canonicalize(oldConfig)!==canonicalize(newConfig))
      throw new DomainError('REVISION_CONFLICT','The source configuration changed. Re-run the known orders with its current generation.',409);
  }
}
export async function proposeScope(db: Database, clock: Clock, i: Installation, input: unknown) {
  const scope = parseScope(input),
    scopeDigest = sha256Hex(canonicalize({
      installationId: i.id,
      operation: installationOperation(i),
      scope
    }));
  if (facilityEnabled('guided',i.organization_id,i.environment,i.location_id) !== Boolean(scope.testedProfile))
    throw new DomainError('INVALID_SCOPE', 'Use the currently enabled setup flow to review these sources.', 409);
  const latest = await workspaceState(db, clock, i);
  if (latest.scopeDigest === scopeDigest && ['active', 'pending'].includes(latest.state)) return latest;
  await requireCurrentGenerations(db,i.id,scope);
  await db.query("UPDATE record_order_sessions SET state='superseded' WHERE installation_id=$1 AND state='pending'", [i.id]);
  const now = clock.now(),
    id = newId('workspace');
  const result = await db.query<Session>("INSERT INTO record_order_sessions(id,installation_id,scope_digest,scope,state,created_at,expires_at) VALUES($1,$2,$3,$4::jsonb,'pending',$5,$6) RETURNING *", [id, i.id, scopeDigest, JSON.stringify(scope), now.toISOString(), new Date(now.getTime() + 900000).toISOString()]);
  return present(clock, i, result.rows[0]);
}
export async function withdrawScope(db: Database,i: Installation,input: unknown) {
  const body=strictBody(input,['scopeDigest']);
  const key=digest(body.scopeDigest);
  const session=(await db.query<Session>('SELECT * FROM record_order_sessions WHERE installation_id=$1 AND scope_digest=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[i.id,key])).rows[0];
  if (!session?.scope.testedProfile || session.state==='active')
    throw new DomainError('REVISION_CONFLICT','This approval changed. Refresh the workspace before editing.',409);
  if (session.state==='pending') await db.query("UPDATE record_order_sessions SET state='superseded' WHERE id=$1",[session.id]);
  return {withdrawn:true};
}
async function administratorSession(db: Database, clock: Clock, w: RecordWorkspace, installationId: string, id: string) {
  requireReconstructionFeature('orderWorkspace');
  const i = await loadInstallation(db, installationId, true);
  if (i.organization_id !== w.organizationId || i.environment !== w.environment || !['ADMIN', 'OWNER'].includes(w.role)) throw new DomainError('SESSION_NOT_FOUND', 'Approval request not found in this workspace.', 404);
  await requireRecordLocation(db, w, i.location_id);
  if (i.status === 'revoked' || i.status === 'paused' || !i.enrollment_acknowledged_at) throw new DomainError('AUTH_REQUIRED', 'This computer must be connected and active.', 403);
  const s = (await db.query<Session>('SELECT * FROM record_order_sessions WHERE id=$1 AND installation_id=$2 FOR UPDATE', [id, i.id])).rows[0];
  if (!s) throw new DomainError('SESSION_NOT_FOUND', 'This approval request could not be found.', 404);
  return {
    i,
    s,
    view: present(clock, i, s)
  };
}
export async function readSession(db: Database, clock: Clock, w: RecordWorkspace, installationId: string, id: string) {
  return (await administratorSession(db, clock, w, installationId, id)).view;
}
export async function decideSession(db: Database, clock: Clock, w: RecordWorkspace, installationId: string, id: string, input: unknown) {
  const body = strictBody(input, ['decision', 'scopeDigest', 'environment', 'organizationId']);
  if (body.decision !== 'approve' && body.decision !== 'deny') throw new DomainError('INVALID_DECISION', 'Choose approve or decline.', 400);
  const {
    i,
    s,
    view
  } = await administratorSession(db, clock, w, installationId, id);
  const state = body.decision === 'approve' ? 'active' : 'denied';
  if (s.scope_digest !== digest(body.scopeDigest)) throw new DomainError('REVISION_CONFLICT', 'The sources changed. Review the current request.', 409);
  if (view.state === state) return view;
  if (view.state !== 'pending') throw new DomainError('REVISION_CONFLICT', 'This request expired or changed. Reopen the current request from Connect.', 409);
  if (state === 'active' && facilityEnabled('guided',i.organization_id,i.environment,i.location_id) !== Boolean(s.scope.testedProfile))
    throw new DomainError('REVISION_CONFLICT','The facility setup policy changed. Request a fresh approval.',409);
  if (state === 'active') await requireCurrentGenerations(db,i.id,s.scope);
  if (state === 'active') await db.query("UPDATE record_order_sessions SET state='superseded' WHERE installation_id=$1 AND state='active'", [i.id]);
  const decided = await db.query<Session>('UPDATE record_order_sessions SET state=$2,decided_by=$3,decided_at=$4 WHERE id=$1 RETURNING *', [id, state, w.userId, clock.now().toISOString()]);
  return present(clock, i, decided.rows[0]);
}
export async function activeScope(db: Database, i: Installation, expected?: string) {
  const s = (await db.query<Session>("SELECT * FROM record_order_sessions WHERE installation_id=$1 AND state='active' FOR SHARE", [i.id])).rows[0];
  if (!s || expected !== undefined && s.scope_digest !== expected) throw new DomainError('AUTH_REQUIRED', 'Approve the current sources and destination in the browser.', 403);
  if (s.scope.testedProfile && !facilityEnabled('guided',i.organization_id,i.environment,i.location_id))
    throw new DomainError('AUTH_REQUIRED','The facility workflow is paused. Review its access before collecting.',403);
  return s;
}
