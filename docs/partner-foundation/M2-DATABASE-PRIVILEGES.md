# M2 database privilege boundary

`backend/scripts/m2-runtime-privileges.mjs` prepares explicit grants for two
separately provisioned API and worker database roles after migrations 093-095.
Its grant-application function is not called by startup or deployment. The gated
envelope runtime calls its read-only verification function before accepting work.
Production migrations 093-095 have now
applied through the separate exact M2 operator, with the old runtime's effective
authority unchanged and no non-owner grants on the six new tables. This privilege
policy has not been activated in production. See the [inactive migration receipt](m2-inactive-production-migration-2026-10-22.json).

| Record | API | Worker |
| --- | --- | --- |
| Claim identity/revisions | Read and append; identity row lock | Read; identity row lock |
| Envelope request | Read and append | Read |
| Envelope delivery | Read and insert initial operation/time columns | Read and update delivery columns |
| Envelope result | Read | Read and append |
| Recipient request | Read and insert request columns | Read and update processing/result columns |
| Recipient approval | Read and append | Read |
| Protected recipient receipt | Read | Read and append |
| Writer fence | Read and lock | Read and lock |

No listed role receives deletion, truncation, trigger authority or record identity
updates. The claim identity lock uses UPDATE(id), whose immutable trigger rejects
actual updates. The fence lock uses UPDATE(singleton), whose CHECK prevents a
different singleton; generation and writes_enabled remain operator-only. Recipient
insertion still supplies the initial state through the existing domain command;
column grants alone do not validate that initial state or the caller's identity.
The API cannot insert protected result receipts or alter processing/result fields.
Domain authorization, immutable triggers and journal verification remain required.

`applyM2RuntimePrivileges(db, {apiRole, workerRole})` runs one owner transaction,
checks the exact three migration receipts, rejects shared/owner/elevated roles,
removes direct table and column grants only on the nine listed tables, grants the
policy, then verifies effective table and column permissions, including refusal
of grant options that could delegate authority to another role. Inherited or PUBLIC
excess rights abort the transaction. It changes no role memberships, login settings,
credentials, application data, schema or unrelated grants. Reapplication is exact.
Do not attach the old broad runtime group and assume a direct REVOKE overrides it.

Provisioning baseline application permissions, real separate task identities,
protected cloud storage, source-bound activation acceptance and merchant/device
acceptance are still required. The inactive rollback bridge and production
migrations are complete as recorded above. A successful
grant receipt is evidence of this database permission boundary only.

The focused CI suite runs the policy against PostgreSQL 16 with independent role
transactions. Local fallback uses PGlite and does not substitute for that gate.
It exercises enqueue/lease permissions, denied result and approval writes,
row locking, forbidden fence changes, inherited grants, transaction rollback,
idempotent application and preservation of unrelated privileges.
