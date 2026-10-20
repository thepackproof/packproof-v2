import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { assertPolicyAccessSafe } from '../domain/policy-recovery.js';

/** Applied to the existing human capture path, including commit and streaming
 * reauthorization. A recorded participant row survives revocation; its presence
 * alone no longer confers current employee authority on organization Proofs. */
export async function requireOrganizationProofAccess(db:Database,proofId:string,userId:string) {
  await assertPolicyAccessSafe(db);
  const binding=(await db.query<{id:string;user_id:string;revoked_at:unknown;enabled:boolean;organization_id:string;merchant_id:string;origin_delegation_id:string|null}>(`
    SELECT m.id,m.user_id,m.revoked_at,o.enabled,m.organization_id,p.merchant_id,p.origin_delegation_id
    FROM platform_proof_ownership p JOIN platform_memberships m ON m.id=p.operator_membership_id
    JOIN platform_organizations o ON o.id=p.merchant_id WHERE p.proof_id=$1 FOR SHARE OF m,o`,[proofId])).rows[0];
  if(!binding || binding.user_id!==userId) return; // Buyer/receiver permissions remain independent.
  if(binding.revoked_at || !binding.enabled) throw denied();
  if(binding.organization_id!==binding.merchant_id) {
    const active=await db.query(`SELECT 1 FROM platform_delegations d JOIN platform_organizations p ON p.id=d.partner_id
      WHERE d.id=$1 AND d.merchant_id=$2 AND d.partner_id=$3 AND d.revoked_at IS NULL
      AND d.expires_at>CURRENT_TIMESTAMP AND p.enabled=true AND d.operator_ids ? $4 AND d.scopes ? 'capture:request' FOR SHARE OF d,p`,
      [binding.origin_delegation_id,binding.merchant_id,binding.organization_id,userId]);
    if(!active.rows[0]) throw denied();
  }
}
export async function requireCaptureOrganizationAuthorization(db:Database,intentId:string) {
  const row=(await db.query<{credential_id:string;delegation_id:string|null}>(`SELECT credential_id,delegation_id FROM platform_capture_authorizations WHERE intent_id=$1`,[intentId])).rows[0];
  if(!row){
    if((await db.query('SELECT 1 FROM capture_intents i JOIN platform_proof_ownership p ON p.proof_id=i.proof_id WHERE i.id=$1',[intentId])).rows[0])throw denied();
    return;
  }
  await requireBackgroundCredential(db,row.credential_id,row.delegation_id,'capture:request');
}
export async function requireBackgroundCredential(db:Database,credentialId:string,delegationId:string|null,scope:string) {
  await assertPolicyAccessSafe(db);
  const active=await db.query(`SELECT 1 FROM platform_credentials c JOIN platform_principals p ON p.id=c.principal_id
    JOIN platform_organizations o ON o.id=p.organization_id JOIN users u ON u.id=p.actor_user_id
    WHERE c.id=$1 AND c.revoked_at IS NULL AND c.expires_at>CURRENT_TIMESTAMP AND p.revoked_at IS NULL AND o.enabled=true AND u.status='ACTIVE' AND c.scopes ? $2
    AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM platform_delegations d JOIN platform_organizations m ON m.id=d.merchant_id
      WHERE d.id=$3 AND d.partner_id=o.id AND d.revoked_at IS NULL AND d.expires_at>CURRENT_TIMESTAMP AND m.enabled=true AND d.scopes ? $2 FOR SHARE OF d,m)) FOR SHARE OF c,p,o,u`,[credentialId,scope,delegationId]);
  if(!active.rows[0])throw denied();
}
export async function requireHumanActor(db:Database,userId:string) {
  if((await db.query('SELECT 1 FROM platform_principals WHERE actor_user_id=$1',[userId])).rows[0])
    throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','A service principal cannot make a personal attestation',403);
}
function denied(){return new DomainError('ORGANIZATION_ACCESS_REVOKED','This organization authorization is no longer active',403);}
