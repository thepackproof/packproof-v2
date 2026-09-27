# System administration: security and operations

The administration API is mounted at `/admin` after the existing PackProof authentication adapter. Every endpoint, including unknown paths, requires a current active account and a `SYSTEM_ADMIN` row in `user_system_roles`. Roles are read on each request and rechecked inside administrative command transactions. Email, client-supplied claims, local storage and UI routing cannot grant this capability.

`GET /me/capabilities` returns `{userId, roles, isAdmin}` to any authenticated active user. The application uses this endpoint to decide whether to show Admin navigation. `GET /admin/me` requires the administrator role.

## Initial administrator

1. Apply the release migrations with the existing separate migration credentials. Run `infra/sql/runtime-roles.sql` after migration, as documented by that script, before admitting the new runtime. The ordinary runtime receives only SELECT on the role table.
2. The `admin@thepackproof.com` account must authenticate normally through Cognito with a verified ID token. This records the verified contact against its immutable internal user ID and Cognito subject.
3. Using an operator database connection, verify the exact internal user ID and Cognito subject; never choose the account solely by display name or an unverified email. Supply these values through the operator environment:

   ```text
   PACKPROOF_ADMIN_BOOTSTRAP_USER_ID=<existing internal user ID>
   PACKPROOF_ADMIN_BOOTSTRAP_COGNITO_SUB=<existing Cognito subject>
   PACKPROOF_ADMIN_BOOTSTRAP_REASON=Initial verified administrator assignment
   PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL=<operator connection, if different from DATABASE_URL>
   ```

4. Run `npm --prefix backend run admin:bootstrap`, or `admin:bootstrap:prod` in the built runtime. The command checks the release schema and, in one transaction, verifies all three identity facts, assigns the role and appends an immutable critical audit event. It is idempotent for the same existing verified administrator and refuses to bootstrap a different administrator once one exists.
5. Sign in with that account and confirm `/me/capabilities` returns `isAdmin: true`. A normal user receives 403 from `/admin/me` and all administrative data routes.

The CLI does not create a user, reset a password, manipulate MFA, transfer a role by email, or change a Cognito group. Keep operator credentials out of the browser and out of ordinary API runtime configuration. There is no role-assignment HTTP endpoint.

## Account and session controls

Account disable and enable use the existing authoritative `users.status` field. Disabling revokes previous Cognito sign-ins and all intake sessions without changing any retained evidence. Re-enabling does not revive those older sign-ins. Self-disable and disabling the last active administrator are rejected.

Session revocation stores a server cutoff in `users.sessions_revoked_before`. The Cognito adapter compares the verified token's `auth_time` on every authentication. Cognito refreshes preserve that authentication time, so an otherwise valid or freshly refreshed JWT from an earlier sign-in remains rejected. A new interactive sign-in is required. Scoped intake sessions are also revoked. Independent recipient disclosure grants retain their own existing authorization model.

Production mutations require a Cognito authentication time within the preceding 15 minutes. Refreshing the token does not renew this window. MFA remains governed by the existing Cognito user-pool policy; the API does not invent an MFA claim. The development identity adapter uses synthetic fixed user IDs rather than production sessions; the recent-authentication gate is explicitly bypassed only with the existing development-auth configuration.

## Mutation protocol

Every supported action is exposed with a descriptor containing `id`, `label`, `path`, `method`, `risk`, an exact target `confirmation`, fixed `body` fields and any additional input `fields`.

All administrative POST commands require:

- `operationId`: 8–100 ASCII letters, digits, underscores or hyphens; generate once and reuse after an uncertain transport result.
- `reason`: 8–1000 characters.
- `confirmation`: the exact target account ID or feature-flag key.
- `expectedVersion`: the version from the latest server response.

Changing a previously used operation's contents returns `ADMIN_IDEMPOTENCY_CONFLICT`. A stale account/flag version returns `ADMIN_VERSION_CONFLICT`; reload the server state before proposing a new operation. Exact repeats return the original response and create no duplicate effect or audit.

Mutations take a transaction-level administrative lock, validate authorization, lock the target state, apply the effect, append an immutable audit and store an immutable response receipt in one transaction. If the audit or receipt write fails, the effect rolls back. This deliberately serializes the relatively infrequent control operations across API instances; list and metric reads do not take this lock.

Supported account endpoints:

| Endpoint | Additional input | Effect |
| --- | --- | --- |
| `POST /admin/users/:id/status` | `status: ACTIVE or DISABLED` | Changes current account access and increments `adminVersion`. |
| `POST /admin/users/:id/revoke-sessions` | None | Invalidates old Cognito sign-ins and current scoped intake sessions. |
| `POST /admin/users/:id/credits` | Nonzero integer `delta`, between -10000 and 10000 | Appends a real adjustment to an active consented plan's capture allowance. |
| `POST /admin/feature-flags/:key` | Boolean `enabled` | Changes one allowlisted, enforced server control. |

## Billing semantics

The current billing implementation has approved, consented offer periods, capture reservations, finalized usage and verified payment ledgers. It does not have a prepaid credit wallet. The administrative allowance action therefore requires an active consented offer period and appends `billing_allowance_adjustments`; it never invents a payment or changes previously published offer terms.

The real capture reservation path includes these adjustments in the effective allowance. A negative adjustment cannot reduce the allowance below already reserved or finalized Proofs. Adjustment, audit and account version advance together. An account without an active offer receives `BILLING_ACTIVE_PERIOD_REQUIRED`. This route is labeled **Adjust plan allowance** in the interface despite retaining the plan's `/credits` endpoint naming.

## Enforced system controls

- `REGISTRATION_PAUSED`: prevents creation of new authentication mappings/accounts; existing users can still sign in.
- `NEW_CAPTURE_PAUSED`: prevents new capture sessions, including supplemental sessions; existing sessions can be fetched, retried idempotently, completed and uploaded normally.

Unknown control keys are rejected. Missing control configuration fails closed. Both flags default to false. Resume uses the same audited action with `enabled: false` and the latest version. Flags do not stop evidence preservation, alter finalized records, block access to existing Proofs or provide arbitrary runtime configuration.

## Integrity and audit

`system_admin_audit_events`, `admin_command_receipts` and `billing_allowance_adjustments` reject UPDATE and DELETE at the database layer. Runtime database privileges additionally deny their UPDATE, DELETE and TRUNCATE operations. The role table is read-only to the runtime. Applying these privilege protections requires a separate schema owner as already required by the deployment architecture.

Administrative routes expose no SQL execution, shell execution, role self-assignment, evidence rewriting, manifest editing or integrity-result overrides. Changes to account access and optional operating controls do not mutate finalized evidence.

## Verification

`backend/tests/system-admin.test.ts` exercises verified identity bootstrap, ordinary-user denial, unauthenticated denial, live role revocation, recent authentication, disable/enable, immutable audit, idempotency conflicts, stale versions, transaction rollback on audit failure, Cognito refresh-token revocation semantics, scoped session revocation, enforced flags, preserved capture recovery and actual ledger-backed capture allowance consumption. Existing identity, disabled-account, billing enrollment and migration tests are also run for regression coverage.

## Integration recovery and error triage

The integration explorer exposes `POST /admin/integrations/:id/disable` and `/retry-sync` only for applicable operational states. A disable changes the local PackProof connection and fences any importer lease; it does not claim to revoke an external provider token remotely. Reauthorization stays with the existing owner OAuth flow.

Sync retries preserve import checkpoints and attempt counters, require a retryable failed state with no live worker lease, honor provider backoff and allow at most three administrative retries after the last successful run. `POST /admin/webhooks/:id/retry` similarly requeues an existing dead outbound delivery without changing its original event or resetting its attempt history. Connections use exact `expectedUpdatedAt` (and sync `expectedSyncUpdatedAt`) from the action descriptor; deliveries use their attempt count and `expectedNextAttemptAt`. Do not handcraft descriptors from cached state.

`POST /admin/errors/:service/:code/status` records `NEW`, `INVESTIGATING`, `RESOLVED` or `IGNORED` in a separate operational annotation. It never edits or removes the underlying failure or original diagnostic. Triage changes use the same version, idempotency, recent-authentication and audit transaction guarantees as other administrative commands.
