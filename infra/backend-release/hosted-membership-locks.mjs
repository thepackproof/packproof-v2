// Metadata and a non-executing PostgreSQL plan, scoped to the actual connection.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const hostedLockPolicySha256 = 'cc1ff79558beac7c7178ccaecdb9c2138e7271077c8df15ff7950a73e6baf743';
const triggerSha256 = '85290fcfa99548c8c15bac587a335bfb30fa35589a76776b63390225fbe63dd6';
const functionSha256 = '981746c709450f6ee117421020f623cfedb9a60591176037df75d12b9b30f774';
const bodySha256 = 'cf116d09c6fb507a38a9f4cfa7cb74a897ee31e0cf4184ef1ec5c13425cf2bf7';
const digest = value => createHash('sha256').update(value).digest('hex');
function requireMatch(value, code) { if (!value) throw Error('HOSTED_MEMBERSHIP_' + code); }

function expectedEvidence(role) {
  return {
    schema:'packproof.hosted-platform-lock-observation/v1', role, policySha256:hostedLockPolicySha256,
    membership:{selectTable:true, updateTable:false, updateColumns:['revoked_at'], grantableUpdate:false,
      idMutable:false, triggerSha256, functionSha256, bodySha256},
    proof:{idUpdate:true, idUpdateGrantable:false},
    membershipLock:{mode:'EXPLAIN WITHOUT ANALYZE', authorized:true, plan:'LockRows/Result/false',
      readOnlyTransaction:true, statementExecuted:false}, grantsApplied:false
  };
}

export function inspectHostedLockEvidence(observed, role) {
  requireMatch(isDeepStrictEqual(observed, expectedEvidence(role)), 'EVIDENCE_MISMATCH');
}

export async function verifyHostedMembershipLocks(db, {kind,apiRole,workerRole}) {
  requireMatch(['api','worker'].includes(kind) && apiRole !== workerRole, 'REVIEW_REQUIRED');
  const role = kind === 'api' ? apiRole : workerRole;
  await db.query('SET LOCAL search_path=public,pg_catalog');
  const identity = (await db.query(`SELECT current_user AS role, session_user AS login,
    current_setting('transaction_read_only') AS ro, current_setting('session_replication_role') AS replication,
    pg_has_role(current_user, c.relowner, 'USAGE') OR r.rolsuper OR r.rolbypassrls OR r.rolreplication
      OR has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,c.oid,'TRIGGER') AS privileged,
    has_table_privilege(current_user,c.oid,'SELECT') AS table_select,
    has_table_privilege(current_user,c.oid,'UPDATE') AS table_update,
    has_any_column_privilege(current_user,c.oid,'UPDATE WITH GRANT OPTION') AS delegated,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0
      AND NOT a.attisdropped AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') ORDER BY a.attnum) AS update_columns,
    has_column_privilege(current_user,'public.proofs','id','UPDATE') AS proof_lock,
    has_column_privilege(current_user,'public.proofs','id','UPDATE WITH GRANT OPTION') AS proof_delegated
    FROM pg_class c JOIN pg_roles r ON r.rolname=current_user WHERE c.oid='public.platform_memberships'::regclass`)).rows[0];
  requireMatch(identity?.role === role && identity.login === role && identity.ro === 'on' &&
    identity.replication === 'origin' && identity.privileged === false, 'LOGIN_MISMATCH');
  requireMatch(identity.table_select === true && identity.table_update === false && identity.delegated === false &&
    isDeepStrictEqual(identity.update_columns,['revoked_at']) && identity.proof_lock === true && identity.proof_delegated === false,
    'PRIVILEGE_MISMATCH');

  const rows = (await db.query(`SELECT t.tgenabled,t.tgdeferrable,t.tginitdeferred,p.prosecdef,
    p.proconfig IS NULL AS default_settings,p.prosrc,pg_get_triggerdef(t.oid,false) AS trigger_definition,
    pg_get_functiondef(t.tgfoid) AS function_definition, p.proowner=c.relowner AS same_owner
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid='public.platform_memberships'::regclass AND t.tgname='platform_memberships_identity' AND NOT t.tgisinternal`)).rows;
  const guard = rows[0];
  requireMatch(rows.length === 1 && guard.tgenabled === 'O' && !guard.tgdeferrable && !guard.tginitdeferred &&
    !guard.prosecdef && guard.default_settings === true && guard.same_owner === true &&
    digest(guard.prosrc) === bodySha256 && digest(guard.trigger_definition) === triggerSha256 &&
    digest(guard.function_definition) === functionSha256, 'IDENTITY_GUARD_MISMATCH');

  // A plain EXPLAIN checks this login's locking privileges. ANALYZE and direct
  // SELECT FOR SHARE are disallowed in a read-only transaction even for WHERE false.
  const explain = await db.query(`EXPLAIN (ANALYZE FALSE, FORMAT JSON, COSTS OFF)
    SELECT m.id FROM public.platform_memberships AS m WHERE false FOR SHARE OF m`);
  const plan = explain.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
  const leaf = plan?.Plans?.[0];
  requireMatch(plan?.['Node Type'] === 'LockRows' && plan.Plans.length === 1 && leaf?.['Node Type'] === 'Result' &&
    leaf['One-Time Filter'] === 'false' && !leaf.Plans && !leaf['Relation Name'], 'LOCK_PLAN_MISMATCH');
  return expectedEvidence(role);
}
