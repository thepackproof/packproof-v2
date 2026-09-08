/** Admission controls never participate in validation of an already admitted Proof. */
export interface IntakeRuntimeConfig {
  enabled: boolean;
  actorIds: readonly string[];
  handoffEnabled: boolean;
  browserEnabled: boolean;
  emailEnabled: boolean;
  shippoEnabled: boolean;
  mailDomain: string | null;
}
export function intakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeRuntimeConfig {
  const candidate = env.PACKPROOF_INTAKE_MAIL_DOMAIN?.trim().toLowerCase() || null;
  // A mail setup error must not stop unrelated capture or recovery.
  const domain = candidate && /^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(candidate) ? candidate : null;
  return {
    enabled: env.PACKPROOF_INTAKE_ENABLED === 'true',
    actorIds: (env.PACKPROOF_INTAKE_ACTOR_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    handoffEnabled: env.PACKPROOF_INTAKE_HANDOFF === 'true',
    browserEnabled: env.PACKPROOF_INTAKE_BROWSER === 'true',
    emailEnabled: env.PACKPROOF_INTAKE_EMAIL === 'true',
    shippoEnabled: env.PACKPROOF_INTAKE_SHIPPO === 'true',
    mailDomain: domain,
  };
}
export function intakeEnabled(config: IntakeRuntimeConfig | undefined, actor: string): boolean {
  return !!config?.enabled && config.actorIds.includes(actor);
}
export async function enrollConfiguredIntakeCohort(db:import('../db/database.js').Database,config:IntakeRuntimeConfig):Promise<void>{
  if(!config.enabled)return;
  // An operator-controlled allowlist opts new merchant admissions into the durable contract.
  // Turning off admission flags never downgrades existing stored contracts.
  for(const actor of config.actorIds)await db.query('INSERT INTO intake_contract_cohorts(owner_user_id,enabled) SELECT id,true FROM users WHERE id=$1 ON CONFLICT(owner_user_id) DO UPDATE SET enabled=true,updated_at=now()',[actor]);
}
