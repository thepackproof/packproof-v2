# Inactive M2 rollback bridge candidate

This branch is based on the exact released foundation source
`99bb2dfe0eb16d8d513617fdd4b9608d7baac3f9`. It is a separate rollback artifact,
not an M2 feature release and not a branch to merge over the current application.
No production deployment, database migration or accepted rollback image is claimed.

Only the schema verifier and its new bounded guard change runtime behavior.
The existing application and its 91 migration files remain at the foundation
release. The three later SQL files are test fixtures, excluded from the image's
active migration directory. No startup migration is added.

## Admission boundary

On its own 91-receipt schema the existing verifier behaves as before. When the
093-095 receipts appear, the bridge accepts only all three exact checksums plus
the pinned unchanged baseline. Partial application, modified receipts and unknown
future schema are rejected. Startup and readiness both invoke this verifier.

The 94-receipt path requires disabled organization/claim feature flags, no
organization rows, non-owner runtime authority without schema CREATE, the six
new tables and the exact enabled protection guards. It rejects any non-owner
table or column ACL on those six tables, including PUBLIC and grants to another
runtime. The existing login needs no SELECT privileges on the new tables.

This read-only guard does not inspect rows that the runtime has no authority to
read. The separately reviewed production migration operator must first establish
that the six tables are empty and strip inherited default grants atomically.
Owner seeding, activation or permissions changes end this rollback window.
Retire the old runtime login before activating the distinct M2 API/worker roles;
do not use this bridge to roll back activated data. Catalog checks detect runtime
activation but do not claim to protect against an owner bypassing the release
procedure.

Migration 094 changes integration-account immutability, and 095 freezes terminal
recipient jobs. This is not a new-tables-only release. The foundation worker's
queued/rendering-to-terminal update shape remains valid; existing terminal
records remain readable and cannot be changed afterward.

## Evidence and remaining acceptance

Seven focused local PGlite checks passed, including exact 91/94 startup, denied
new-table reads, wrong/partial receipts, feature flags, table/column activation
grants, organization activation, damaged guards, and the legacy recipient SQL
transition with unchanged accepted terminal bytes. The new guard passed strict
TypeScript checking. These are not deployed application or media-render tests.

The focused workflow also executes the bridge checks against PostgreSQL 16 with
a non-owner runtime role. Its result must be recorded at the exact published
commit. Before accepting this image as a production fallback, build and scan its
immutable image, run the actual legacy application/recipient behavior against
the migrated isolated schema, verify exact historical manifest signatures and
original object versions, and complete a configuration-bound canary. Bind that
evidence into the inactive M2 migration inspection before applying 093-095.

Keep production features inactive throughout migration. The full M2 merchant
release still requires production role/storage protection, authenticated client
and device acceptance, and a consenting merchant pilot.
