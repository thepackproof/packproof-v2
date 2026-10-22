# Foundation rollback bridge

This branch is based exactly on production `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a`. Its only runtime changes are the five exact forward-compatible migration receipts and an activation guard.

It can run before or after the atomic 088-092 migration while the organization schema is empty. It rejects partial receipts, altered checksums, unknown future schema, and any organization activation. Organization APIs must stay disabled throughout bridge deployment, migration and candidate canary. Once organization records exist, this old application is not a rollback target: retain an organization-aware candidate with feature activation disabled instead.

This source is not a migration command and does not authorize DDL. Build, scan and validate the immutable bridge against isolated PostgreSQL before production use. Do not merge this temporary startup guard into the organization-aware main application.
