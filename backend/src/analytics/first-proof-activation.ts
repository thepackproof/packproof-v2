import type {Database} from '../db/database.js';
import {ELIGIBLE_PACKING_PROOFS_SQL,ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL} from '../domain/onboarding.js';

/** Existing operational records only: no new browser collection, identifiers in
 * the result, or use of tutorial completion as customer activation. */
export async function firstProofActivation(db:Database,input:{from:string;to:string;asOf:string}) {
 const row=(await db.query<{eligible_accounts:number;mature_accounts:number;immature_accounts:number;activated_accounts:number;never_started_accounts:number}>(`
  WITH cohort AS (
    SELECT u.id,u.created_at FROM users u WHERE u.created_at >= $1 AND u.created_at < $2 AND u.created_at <= $3
      AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider<>'dev')
      AND NOT EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.provider='dev')
      AND NOT EXISTS(SELECT 1 FROM user_system_roles role WHERE role.user_id=u.id AND role.role='SYSTEM_ADMIN')
  ), first_finalized AS (
    SELECT p.seller_user_id,MIN(p.finalized_at) AS finalized_at FROM (${ELIGIBLE_FINALIZED_PACKING_PROOFS_SQL}) p
    JOIN cohort c ON c.id=p.seller_user_id WHERE p.finalized_at <= $3 GROUP BY p.seller_user_id
  ), first_started AS (
    SELECT p.seller_user_id,MIN(p.created_at) AS created_at FROM (${ELIGIBLE_PACKING_PROOFS_SQL}) p
    JOIN cohort c ON c.id=p.seller_user_id WHERE p.created_at <= $3 GROUP BY p.seller_user_id
  ) SELECT COUNT(*)::integer AS eligible_accounts,
    COUNT(*) FILTER(WHERE c.created_at <= $3::timestamptz-INTERVAL '7 days')::integer AS mature_accounts,
    COUNT(*) FILTER(WHERE c.created_at > $3::timestamptz-INTERVAL '7 days')::integer AS immature_accounts,
    COUNT(*) FILTER(WHERE c.created_at <= $3::timestamptz-INTERVAL '7 days' AND f.finalized_at >= c.created_at AND f.finalized_at <= c.created_at+INTERVAL '7 days')::integer AS activated_accounts,
    COUNT(*) FILTER(WHERE c.created_at <= $3::timestamptz-INTERVAL '7 days' AND s.created_at IS NULL)::integer AS never_started_accounts
  FROM cohort c LEFT JOIN first_finalized f ON f.seller_user_id=c.id LEFT JOIN first_started s ON s.seller_user_id=c.id
 `,[input.from,input.to,input.asOf])).rows[0];
 const mature=Number(row.mature_accounts),activated=Number(row.activated_accounts);
 return {definitionVersion:1,asOf:input.asOf,eligibleAccounts:Number(row.eligible_accounts),matureAccounts:mature,immatureAccounts:Number(row.immature_accounts),activatedAccounts:activated,neverStartedAccounts:Number(row.never_started_accounts),activationPercent:mature?Math.round(activated/mature*1000)/10:null,
  intentConversion24h:{status:'unavailable' as const,reason:'An account-scoped Create Proof choice timestamp is not collected for the full customer population. Proof creation is not substituted for that intent.'},
  eligibility:'Accounts created in the selected registration window with a non-development authentication identity, no development identity, and no current system-admin role. Only accounts with seven complete days as of the observation cutoff enter the rate; nonstarters remain included. Sandbox, sample, demo, viewer-only and imported-only activity cannot satisfy packing activation.',
 };
}
