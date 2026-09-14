import { ebayIdentityAccount } from '../integrations/ebay/normalize.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import { DomainError } from './errors.js';
import type { EbayEnvironment } from '../integrations/ebay/constants.js';
import type { MutableCredentialStore } from '../integrations/credentials.js';
import { parseEbayDeletionNotification } from '../integrations/ebay/account-deletion.js';

type Credentials = Partial<Pick<MutableCredentialStore, 'deleteCredentials'>>;

export async function lockEbayPrivacy(tx:Database):Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(1347438146,1309)');
}

export async function isEbaySubjectSuppressed(db: Database, environment: EbayEnvironment, userId?: string | null, username?: string | null): Promise<boolean> {
  if (!userId && !username) return false;
  return !!(await db.query(`SELECT 1 FROM ebay_deletion_cases WHERE environment=$1 AND
    (($2::text IS NOT NULL AND subject_user_id=$2) OR ($3::text IS NOT NULL AND subject_username=$3)) LIMIT 1`, [environment,userId ?? null,username ?? null])).rows[0];
}

/** Called only after the HTTP boundary verifies eBay's signature. */
export async function receiveEbayDeletion(db: Database, clock: Clock, body: unknown, environment: EbayEnvironment, credentials: Credentials) {
  const subject = parseEbayDeletionNotification(body);
  const now = clock.now().toISOString();
  const accepted = await db.transaction(async tx => {
    await lockEbayPrivacy(tx);
    const inserted = await tx.query<{id:string}>(`INSERT INTO ebay_deletion_cases
      (id,environment,notification_id,subject_user_id,subject_username,state,received_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'CREDENTIAL_REMOVAL_PENDING',$6,$6)
      ON CONFLICT(environment,notification_id) DO NOTHING RETURNING id`,
      [newId('ebdel'),environment,subject.notificationId,subject.userId,subject.username,now]);
    if (!inserted.rows[0]) {
      const existing = (await tx.query<{id:string}>('SELECT id FROM ebay_deletion_cases WHERE environment=$1 AND notification_id=$2',[environment,subject.notificationId])).rows[0];
      return { id:existing.id, connectionsDisabled:0 };
    }
    const id = inserted.rows[0].id;
    const connections = (await tx.query<{id:string;credential_reference:string}>(`SELECT DISTINCT c.id,c.credential_reference FROM integration_connections c
      LEFT JOIN connected_accounts a ON a.id=c.id WHERE c.adapter_key='ebay'
      AND (a.provider_metadata->>'environment'=$1 OR a.id IS NULL)
      AND (($2::text IS NOT NULL AND a.provider_metadata->>'ebayUserId'=$2)
        OR ($3::text IS NOT NULL AND ($2::text IS NULL OR a.provider_metadata->>'ebayUserId' IS NULL OR a.provider_metadata->>'ebayUserId'=$2) AND (a.external_account_name=$3 OR a.provider_metadata->>'ebayUsername'=$3 OR c.external_account_reference=$3))
        OR ($2::text IS NOT NULL AND c.external_account_reference=$2))`, [environment,subject.userId,subject.username])).rows;
    const ids = connections.map(c=>c.id);
    for (const connection of connections) {
      await tx.query("UPDATE integration_connections SET status='DISABLED',auto_sync_enabled=false,updated_at=$2 WHERE id=$1",[connection.id,now]);
      await tx.query("UPDATE commerce_connection_sync_states SET lease_token=NULL,lease_expires_at=NULL,next_run_at=NULL,run_status='IDLE' WHERE connection_id=$1",[connection.id]);
      await tx.query("UPDATE connected_accounts SET status='DISCONNECTED',disconnected_at=$2,updated_at=$2 WHERE id=$1",[connection.id,now]);
    }
    // Inventory protected records for review. Never rewrite a signed manifest to claim erasure.
    const selectors = [subject.userId,subject.username].filter(Boolean);
    const sellerTenant = subject.userId ? `marketplace:ebay:${ebayIdentityAccount(environment,subject.userId)}` : null;
    const proofs = (await tx.query<{id:string}>(`WITH seller_connections AS (
      SELECT id,owner_user_id,external_account_reference FROM integration_connections WHERE adapter_key='ebay' AND id=ANY($2::text[])
    ), observations AS (
      SELECT t.id AS transaction_id,t.transaction_metadata #> '{import,buyer}' AS buyer,
        COALESCE(t.transaction_metadata #>> '{import,providerIdentifiers,environment}',
          CASE WHEN t.transaction_metadata #>> '{import,tenantKey}' LIKE 'marketplace:ebay:%'
            THEN split_part(split_part(t.transaction_metadata #>> '{import,tenantKey}',':',3),'.',1) END) AS environment
      FROM transactions t WHERE t.transaction_metadata #>> '{import,provider}'='ebay'
      UNION ALL
      SELECT s.transaction_id,s.snapshot->'buyer',COALESCE(s.snapshot #>> '{providerIdentifiers,environment}',
        CASE WHEN s.tenant_key LIKE 'marketplace:ebay:%' THEN split_part(split_part(s.tenant_key,':',3),'.',1) END)
      FROM transaction_source_observations s WHERE s.snapshot->>'provider'='ebay'
    ), revisions AS (
      SELECT o.transaction_id,o.connection_id,r.normalized_order->'buyer' AS buyer,
        COALESCE(r.normalized_order->>'providerEnvironment',CASE WHEN o.commerce_tenant_key LIKE 'marketplace:ebay:%'
          THEN split_part(split_part(o.commerce_tenant_key,':',3),'.',1) END) AS environment
      FROM commerce_order_records o JOIN commerce_order_revisions r ON r.order_record_id=o.id
      WHERE r.normalized_order->>'provider'='ebay'
    ), matches AS (
      SELECT i.transaction_id FROM transaction_integration_identities i
        WHERE $4::text IS NOT NULL AND i.tenant_key=$4 AND i.adapter_key='ebay'
      UNION
      SELECT i.transaction_id FROM transaction_integration_identities i JOIN transactions t ON t.id=i.transaction_id
        JOIN seller_connections c ON c.owner_user_id=t.created_by WHERE i.adapter_key='ebay'
        AND (i.tenant_key='marketplace:ebay:'||$1::text OR i.tenant_key='marketplace:ebay:'||$1::text||'.'||c.external_account_reference)
      UNION
      SELECT transaction_id FROM revisions WHERE environment=$1 AND connection_id=ANY($2::text[])
      UNION
      SELECT transaction_id FROM observations WHERE environment=$1
        AND (buyer->>'externalId'=ANY($3::text[]) OR buyer->>'displayName'=ANY($3::text[]))
      UNION
      SELECT transaction_id FROM revisions WHERE environment=$1
        AND (buyer->>'externalId'=ANY($3::text[]) OR buyer->>'displayName'=ANY($3::text[]))
    ) SELECT DISTINCT p.id FROM proofs p JOIN matches m ON m.transaction_id=p.transaction_id ORDER BY p.id`,
      [environment,ids,selectors,sellerTenant])).rows;
    await tx.query(`UPDATE ebay_deletion_cases SET connection_ids=$2::jsonb,credential_references=$3::jsonb,affected_proof_ids=$4::jsonb WHERE id=$1`,
      [id,JSON.stringify(ids),JSON.stringify(connections.map(c=>c.credential_reference)),JSON.stringify(proofs.map(p=>p.id))]);
    return {id,connectionsDisabled:ids.length};
  });
  // A retryable queue remains even when the secret service is temporarily unavailable.
  await processEbayDeletionCase(db,clock,credentials,accepted.id);
  const state = (await db.query<{state:string}>('SELECT state FROM ebay_deletion_cases WHERE id=$1',[accepted.id])).rows[0].state;
  return {accepted:true as const, caseId:accepted.id, connectionsDisabled:accepted.connectionsDisabled, deletionStatus:state, recordsErased:false as const};
}

async function processEbayDeletionCase(db:Database,clock:Clock,credentials:Credentials,id:string):Promise<boolean> {
  let attemptCount = 0;
  try {
    return await db.transaction(async tx=>{
      await lockEbayPrivacy(tx);
      const row=(await tx.query<{credential_references:string[];attempt_count:number}>(`SELECT credential_references,attempt_count FROM ebay_deletion_cases WHERE id=$1 AND state='CREDENTIAL_REMOVAL_PENDING' FOR UPDATE`,[id])).rows[0];
      if(!row)return true;
      attemptCount = row.attempt_count;
      if(row.credential_references.length && !credentials.deleteCredentials) throw new DomainError('CREDENTIAL_REMOVAL_UNAVAILABLE','Credential deletion is unavailable',503);
      for(const reference of row.credential_references) await credentials.deleteCredentials!({adapterKey:'ebay',credentialReference:reference});
      await tx.query(`UPDATE connected_accounts SET external_account_id='deleted-'||id,external_account_name=NULL,provider_metadata='{}'::jsonb,updated_at=$2
        WHERE id IN (SELECT jsonb_array_elements_text(connection_ids) FROM ebay_deletion_cases WHERE id=$1)`,[id,clock.now().toISOString()]);
      await tx.query(`UPDATE integration_connections SET external_account_reference='deleted-'||id,updated_at=$2
        WHERE id IN (SELECT jsonb_array_elements_text(connection_ids) FROM ebay_deletion_cases WHERE id=$1)`,[id,clock.now().toISOString()]);
      await tx.query(`UPDATE ebay_deletion_cases SET state='REVIEW_REQUIRED',credential_references='[]'::jsonb,last_error_code=NULL,next_attempt_at=NULL,updated_at=$2 WHERE id=$1`,[id,clock.now().toISOString()]);
      return true;
    });
  } catch {
    await db.query(`UPDATE ebay_deletion_cases SET attempt_count=attempt_count+1,last_error_code='CREDENTIAL_REMOVAL_RETRY',next_attempt_at=$2,updated_at=$3 WHERE id=$1 AND state='CREDENTIAL_REMOVAL_PENDING'`,
      [id,new Date(clock.now().getTime()+Math.min(3600000,30000*2**Math.min(attemptCount,7))).toISOString(),clock.now().toISOString()]);
    return false;
  }
}
export async function dispatchEbayDeletionCases(db:Database,clock:Clock,credentials:Credentials) {
  const cases=(await db.query<{id:string}>(`SELECT id FROM ebay_deletion_cases WHERE state='CREDENTIAL_REMOVAL_PENDING' AND (next_attempt_at IS NULL OR next_attempt_at<=$1) ORDER BY received_at LIMIT 10`,[clock.now().toISOString()])).rows;
  let failed = 0;
  for(const item of cases) if (!await processEbayDeletionCase(db,clock,credentials,item.id)) failed++;
  return {processed:cases.length,failed};
}
