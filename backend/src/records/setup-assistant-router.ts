import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { requireRecordWorkspace, requireRecordLocation } from './access.js';
import { loadInstallation } from './agent-enrollments.js';
import { requireReconstructionFeature } from './reconstruction-features.js';
import { facilityEnabled } from './facility-flags.js';
import { readSetupInput, requestSuggestions } from './setup-suggestions.js';

const route = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);
const missing = () => new DomainError('INSTALLATION_NOT_FOUND', 'This workspace is unavailable for this account.', 404);
const manual = () => new DomainError('SETUP_ASSISTANT_UNAVAILABLE', 'Continue setup using the manual choices.', 503);

async function access(tx: Database, r: Request, userId: string) {
  requireReconstructionFeature('orderWorkspace');
  const w = await requireRecordWorkspace(tx, userId, r.query.organizationId, r.query.environment);
  const i = await loadInstallation(tx, r.params.installationId);
  if (i.organization_id !== w.organizationId || i.environment !== w.environment || !i.enrollment_acknowledged_at ||
      i.status === 'revoked' || i.renewal_credential_id || !facilityEnabled('guided', i.organization_id, i.environment, i.location_id)) throw missing();
  await requireRecordLocation(tx, w, i.location_id);
  if (w.role === 'OPERATOR' && w.membershipId !== i.operator_membership_id) throw missing();
  return { installation: i, canConfigure: w.role === 'OWNER' || w.role === 'ADMIN' };
}

function budget(key: string, fallback: number, limit: number) {
  const n = Number(process.env[key] ?? fallback);
  return Number.isSafeInteger(n) && n >= 0 && n <= limit ? n : 0;
}

export function setupAssistantRouter(deps: AppDependencies, provider = requestSuggestions) {
  const router = express.Router();
  const base = '/agent-installations/:installationId';
  router.get(base + '/workspace-access', route(async (r, res) => {
    const actor = await deps.auth.authenticate(r.headers);
    const { canConfigure, installation: i } = await deps.db.transaction(tx => access(tx, r, actor.userId));
    return res.set('Cache-Control', 'private, no-store').json({ canConfigure, organizationId: i.organization_id, environment: i.environment, locationId: i.location_id, userId: actor.userId });
  }));
  router.post(base + '/facility-setup/suggestions/v1', route(async (r, res) => {
    const user = (await deps.auth.authenticate(r.headers)).userId;
    const input = readSetupInput(r.body);
    const digest = sha256Hex(canonicalize(input));
    const key = [r.params.installationId, input.draftId, user];
    async function authorize(tx: Database) {
      const { canConfigure, installation: i } = await access(tx, r, user);
      if (!canConfigure || !facilityEnabled('assistant', i.organization_id, i.environment, i.location_id)) throw missing();
    }
    const saved = await deps.db.transaction(async tx => {
      await authorize(tx);
      // Serialize reservations before spending the site's call allowance, including across draft IDs.
      await tx.query('SELECT pg_advisory_xact_lock(1347438155,hashtext($1))', [key[0]]);
      await tx.query(`INSERT INTO record_setup_drafts(installation_id,draft_id,requester_id,latest_revision)
        VALUES($1,$2,$3,$4) ON CONFLICT (installation_id,draft_id,requester_id) DO NOTHING`, [...key, input.revision]);
      const current = (await tx.query<{latest_revision: number}>('SELECT latest_revision FROM record_setup_drafts WHERE installation_id=$1 AND draft_id=$2 AND requester_id=$3 FOR UPDATE', key)).rows[0];
      if (current.latest_revision > input.revision) throw new DomainError('REVISION_CONFLICT', 'The setup draft changed.', 409);
      await tx.query('UPDATE record_setup_drafts SET latest_revision=$4 WHERE installation_id=$1 AND draft_id=$2 AND requester_id=$3', [...key, input.revision]);
      const previous = (await tx.query<{result: {suggestions: unknown[]}|null}>('SELECT result FROM record_setup_requests WHERE installation_id=$1 AND draft_id=$2 AND requester_id=$3 AND digest=$4', [...key,digest])).rows[0];
      if (previous) { if (!previous.result) throw manual(); return previous.result; }
      const counts = (await tx.query<{daily: string; draft: string}>(`SELECT count(*) FILTER (WHERE created_at >= $3::timestamptz - interval '1 day') AS daily,
        count(*) FILTER (WHERE draft_id=$2) AS draft FROM record_setup_requests WHERE installation_id=$1`, [key[0],input.draftId,deps.clock.now().toISOString()])).rows[0];
      if (Number(counts.draft) >= budget('PACKPROOF_SETUP_AI_DRAFT_CALLS', 5, 25) || Number(counts.daily) >= budget('PACKPROOF_SETUP_AI_DAILY_CALLS', 30, 250)) throw manual();
      await tx.query('INSERT INTO record_setup_requests(installation_id,draft_id,requester_id,digest,revision,created_at) VALUES($1,$2,$3,$4,$5,$6)', [...key,digest,input.revision,deps.clock.now().toISOString()]);
      return null;
    });
    res.set('Cache-Control', 'private, no-store');
    if (saved) return res.json({ ...saved, revision: input.revision });
    const start = Date.now();
    let produced: Awaited<ReturnType<typeof provider>> | undefined;
    try { produced = await provider(input); } catch { /* The manual path remains available. */ }
    const result = await deps.db.transaction(async tx => {
      await authorize(tx);
      const row = (await tx.query<{latest_revision: number}>('SELECT latest_revision FROM record_setup_drafts WHERE installation_id=$1 AND draft_id=$2 AND requester_id=$3 FOR UPDATE', key)).rows[0];
      const valid = !!produced && row.latest_revision === input.revision;
      const result = valid ? { suggestions: produced!.suggestions } : null;
      await tx.query('UPDATE record_setup_requests SET result=$5::jsonb,tokens=$6,duration_ms=$7,outcome=$8 WHERE installation_id=$1 AND draft_id=$2 AND requester_id=$3 AND digest=$4',
        [...key,digest,result ? JSON.stringify(result) : null,produced?.tokens ?? 0,Date.now()-start,valid?'suggested':row.latest_revision!==input.revision?'superseded':'unavailable']);
      return result;
    });
    if (!result) throw manual();
    return res.json({ ...result, revision: input.revision });
  }));
  return router;
}
