// Synthetic acceptance only. This is not a general application runtime policy.
// Provision fresh, unrelated roles before invoking; never attach the legacy broad group.
import assert from 'node:assert/strict';
import {applyM2RuntimePrivileges} from './m2-runtime-privileges.mjs';

export async function grantIsolatedRecipientRoles(db,{apiRole,workerRole,purpose}) {
 assert.equal(purpose,'isolated-m2-synthetic');
 assert.notEqual(apiRole,workerRole);
 for(const role of [apiRole,workerRole])assert.match(role,/^m2_recipient_(api|worker)_[a-z0-9_]+$/);
 return db.transaction(async tx=>{
  const schema=(await tx.query('SELECT current_schema() AS name')).rows[0].name;
  assert.match(schema,/^[a-z][a-z0-9_]+$/);
  // Only freshly provisioned isolated roles are eligible, with no group inheritance.
  for(const role of [apiRole,workerRole]) {
   const identity=(await tx.query('SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
   assert.ok(identity&&!identity.rolsuper&&!identity.rolcreatedb&&!identity.rolcreaterole&&!identity.rolreplication&&!identity.rolbypassrls);
   assert.equal((await tx.query('SELECT 1 FROM pg_auth_members WHERE member=$1',[identity.oid])).rows.length,0);
   assert.equal((await tx.query('SELECT 1 FROM pg_class WHERE relowner=$1',[identity.oid])).rows.length,0);
   assert.equal((await tx.query("SELECT has_schema_privilege($1,current_schema(),'CREATE') AS allowed",[role])).rows[0].allowed,false);
   assert.equal((await tx.query(`SELECT 1 FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r'
    AND (has_table_privilege($1,oid,'INSERT') OR has_table_privilege($1,oid,'UPDATE') OR has_table_privilege($1,oid,'DELETE')) LIMIT 1`,[role])).rows.length,0);
   await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
   // The fixture database contains synthetic records only. Broad reads here are
   // intentional for full recovery snapshots, and do not define production reads.
   await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
   await tx.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
   await tx.query(`GRANT INSERT ON audit_events,recovery_events TO ${role}`);
   await tx.query(`GRANT INSERT(operation_id,next_attempt_at) ON recovery_delivery TO ${role}`);
   // Row-level locking requires UPDATE on at least one column. IDs stay immutable.
   for(const table of ['users','platform_organizations','platform_memberships'])await tx.query(`GRANT UPDATE(id) ON ${table} TO ${role}`);
  }
  await tx.query(`GRANT UPDATE ON recovery_delivery,policy_recovery_delivery TO ${workerRole}`);
  await tx.query(`GRANT UPDATE(reconciled_sequence,reconciled_head_sha256) ON policy_recovery_fence TO ${workerRole}`);
  await tx.query(`GRANT UPDATE(status,manifest_id,finalized_at,updated_at) ON proofs TO ${workerRole}`);
  return applyM2RuntimePrivileges(tx,{apiRole,workerRole});
 });
}
