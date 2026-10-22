# M2 database privilege boundary

`backend/scripts/m2-runtime-privileges.mjs` prepares explicit grants for two
separately provisioned API and worker database roles after migrations 093-095.
It is not called by startup or deployment. No production grant or migration is
implied by this source change, and the existing foundation operator remains pinned
to its original migration boundary.

| Record | API | Worker |
| --- | --- | --- |
| Claim identity/revisions | Read and append; identity row lock | Read |
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
policy, then verifies effective table and column permissions. Inherited or PUBLIC
excess rights abort the transaction. It changes no role memberships, login settings,
credentials, application data, schema or unrelated grants. Reapplication is exact.
Do not attach the old broad runtime group and assume a direct REVOKE overrides it.

Provisioning baseline application permissions, real separate task identities,
protected cloud storage, source-bound acceptance, the compatible rollback bridge,
production migration and merchant/device acceptance are still required. A successful
grant receipt is evidence of this database permission boundary only.

The focused CI suite runs the policy against PostgreSQL 16 with independent role
transactions. Local fallback uses PGlite and does not substitute for that gate.
It exercises enqueue/lease permissions, denied result and approval writes,
row locking, forbidden fence changes, inherited grants, transaction rollback,
idempotent application and preservation of unrelated privileges.
