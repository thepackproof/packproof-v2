# Records API and worker privilege boundary

`backend/scripts/records-runtime-privileges.mjs` provides a bounded SQL planner and
a read-only actual-runtime preflight for migrations 096–100. Importing or running
these functions does not apply migrations/grants, provision logins, create roles,
change memberships or enable the feature. Production migration compatibility and
activation remain separate gates.

## Scope and source binding

The planner controls only the 19 new records tables and
`record_issue_actions_sequence_seq`. It validates source migration SHA-256 values,
live migration receipts and exact table-column inventory. Its input requires an
explicit reviewed 40-character source commit, reviewed migration-inventory digest,
schema, runtime role and separate worker role. SQL identifiers are restricted and
quoted; targets come from the fixed policy rather than caller-supplied table or
column lists. Every write is column scoped. Neither role receives DELETE,
TRUNCATE, REFERENCES, TRIGGER or grant options on these objects.

The source schema parser is deliberately limited to the reviewed CREATE TABLE
syntax in these migrations. Unsupported/missing source tables or live extra
columns fail closed; update and review the policy when the schema changes.
“Source bound” here means exact reviewed application/migration inputs. Deployment
still has to prove that the running immutable image contains those bytes.

| Object group | API runtime | Worker |
| --- | --- | --- |
| Locations and membership-location grants | Read only | Read only |
| Operational record state | Create and update permitted metadata/review/revision fields | Create imports/projections; update revision/time only |
| Entities | Read and append | Read and append for CSV ingestion |
| Evidence associations, requirements, waivers, issues, actions, amendments | Read and append; no history updates | No human-review/waiver writes |
| Command results | Append request identity; update response only | No access |
| CSV source receipts | Append original/mapping/source rows; confirm/retry bounded state | Read sources; update processing/row result/lease fields only |
| Connection controls | Append request/control identity; update pause/control revision | Update measured health and processing/lease results only |
| Workspace registration requests | Read and append | No access |
| Source-observation operations/receipts/identities | Append accepted source identity and payload; update initial operation outcome | Read immutable input; update operation/receipt processing results only |
| Review-action sequence | USAGE only | No access |

Table privileges do not establish caller authorization or valid initial states.
Domain checks, immutable triggers, verified source bytes and current tenant/grant
checks remain necessary. This policy does not grant baseline access to canonical
Proof, user, audit/outbox, shipment-event, recovery or existing platform tables.
For example, source ingestion needs the existing canonical shipment-event path;
CSV ingestion needs the existing transaction/Proof path. Verify those exact
baseline permissions separately without attaching an owner/broad runtime group.

## Reviewed operating sequence

1. Freeze and review the candidate source plus migrations. Obtain
   `recordsMigrationInventory()` and retain its digest in the release input. An
   operator must compare this value with the approved artifact, not blindly copy
   a value from whatever source happens to be running.
2. Reconcile the actual production baseline and prepare the compatible bridge.
   Apply additive migrations with the existing reviewed owner-only migration
   operator. An ordinary runtime must never apply DDL at startup.
3. Separately provision the exact nonowner runtime/worker logins and their
   reviewed baseline permissions. The planner refuses missing/combined roles,
   either role inheriting the other, elevated/owner membership, schema creation
   authority and delegation rights. Required schema usage, read-only migration
   inventory and safe system-catalog inspection must already be available.
4. Call `planRecordsRuntimePrivileges(db, options)` from the authorized operator
   path. Review the bounded statement list, source/migration/policy digest and
   statement digest. It revokes only direct privileges on its named objects and
   grants the exact reviewed policy; unrelated grants are untouched. A direct
   REVOKE cannot override an inherited or PUBLIC privilege.
5. Execute approved statements through the existing controlled operator in one
   transaction and retain the receipt. Keep feature admission closed. If inherited
   or PUBLIC authority prevents the intended result, correct it through its
   policy owner; do not widen this policy to match the drift.
6. Establish real connections under each intended runtime login and call
   `verifyRecordsRuntimePrivileges(db, options)` with the candidate's
   `PACKPROOF_RELEASE_SHA`. The function is read only. It requires
   `session_user === current_user ===` one of the two exact roles; an owner login
   using `SET ROLE` cannot pass. It validates both roles' effective table, column
   and sequence rights including inherited/PUBLIC and grant options.
7. Retain source-bound receipts and run the domain/media/import/source jobs under
   those actual process identities. Only then consider the independent
   [release gates](RELEASE_GATES.md). A passing privilege receipt is not consent,
   storage protection, a successful connector or general availability.

The planner intentionally cannot choose additional tables, accept arbitrary
future migration receipts, change ownership or grant privileges to PUBLIC. Its
read-only verifier fails on source/schema/role drift. It is not an automatic
production grant application tool.

## Focused verification

The local suite `backend/tests/records-runtime-privileges.test.ts` passed five
cases against an isolated in-memory database. It exercises the source-bound plan,
API/worker separation, forbidden history/source writes, owner `SET ROLE`, invalid
identifiers, inherited/PUBLIC/grantable excess, sequence scope, altered migration
receipts and unexpected live columns. It explicitly configures synthetic session
authorization for test roles; this is not a hosted login acceptance result.
It also inserts actual source operations/receipts with connection-control revision
and normalized payload under the API role, admits the explicit revision UPSERT
with EXPLAIN under both roles, allows worker status updates, and denies changes to
the preserved raw/normalized source or connection fence. EXPLAIN does not execute
the separate policy-journal trigger path; baseline trigger grants remain untested
by that particular statement check.

Set only `PACKPROOF_TEST_DATABASE_URL` to an explicit isolated PostgreSQL test
connection to run the same suite on PostgreSQL. Never point this test at customer
data: its fixture creates test roles/schema and grants in that isolated target.
Application database credentials are not used as a fallback.
