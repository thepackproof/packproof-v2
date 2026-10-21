# Organization foundation operations

## Configuration and secrets

| Setting | Purpose / activation |
| --- | --- |
| `PACKPROOF_ORGANIZATIONS_ENABLED` | Default off. Set exactly `true` only for a reviewed cohort/environment. This is not a production authorization. |
| `PACKPROOF_EVENT_CURSOR_KEY` | Separate random 32-byte base64 HMAC key in managed secrets. Used for event and Proof-list cursors with domain separation. Never reuse an API key, webhook encryption key or signing key. |
| Existing webhook encryption configuration | Encrypts webhook secrets and sensitive replay results. Keep the established rotation/read-key history; inspect `webhookConfigFromEnv` and the current webhook runbook. |
| Existing Cognito/session configuration | Organization administration requires a first-party person and verified authentication time within five minutes. Test fixtures alone may bypass this freshness check. Configure and demonstrate strong authentication before live entitlement; freshness alone is not MFA evidence. |
| Existing preservation/signing/retention settings | Retain the configured recovery worker, independent journal bucket/key, writer fence and reviewed storage evidence. Do not substitute test keys or change Object Lock mode as part of this migration. |
| `PACKPROOF_TEST_DATABASE_URL` | Explicit isolated PostgreSQL connection for the shared organization and T07 tests. No fallback to the application database URL. Each suite creates/drops only its own random schema. |

Server credentials expire within 90 days. Rotate by issuing a limited replacement, confirming integration operation, then revoking the old credential. Principal revocation disables all its credentials. Grants also expire within 90 days and cannot silently change scopes/operators after issuance. Membership/principal/credential/grant revocation is monotonic at the database layer. Use a new reviewed grant or identity instead of rewriting history.

## Before enabling

1. Pin API/worker/client artifacts and migration checksums to the candidate commit. Record deployed versions separately from source history.
2. Run `backend/scripts/organization-preflight.sql` read-only against the intended baseline. Save exact existing manifest bytes/hashes and representative .pkpr exports in restricted release evidence. Record unresolved legacy mappings; do not guess or automatically adopt them.
3. Restore the baseline to a separate staging target with private storage. Run migrations normally. Migration 088 briefly locks the outbox and tenant bindings for a complete stream backfill; measure time/lock impact on a representative copy before scheduling production.
4. Generate the cursor secret separately. Run the PostgreSQL CI scenario and then the full staging foundation flow with two distinct merchant owners, a partner and three operators. Verify cursor catch-up, revoked in-flight capture, exports and queued delivery. PGlite is insufficient for these deployment semantics.
5. Run the existing fresh-target recovery procedure with protected core and policy journals, original object versions, independent signed heads and old-writer fencing. Include the new organization authority rows and revoked grants. A missing capture/webhook association must block use. Recreate subscriptions only after current authorization review; reconcile notifications with the safe feed.
6. Verify storage IAM, TLS, Object Lock/version retention, signing-key trust, deletion/hold behavior and Cognito strong-authentication settings. Do not widen live access until the evidence record identifies the exact environment and actual results.

## Recovery behavior and compatibility

- `FINALIZATION_CONTEXT_CHANGED`: inspect current Proof and human attestation context, then retry. Never attach a signature to modified bytes.
- `POLICY_DURABILITY_PENDING`: let the existing policy worker preserve the committed authorization decision, then retry the same operation/key. A response lost during this wait must not create a second order.
- `ORGANIZATION_ACCESS_REVOKED` / `INSUFFICIENT_SCOPE`: stop current privileged work. Retain local footage until an explicitly authorized recovery path exists; do not silently upload under another user or Proof.
- `EVENT_CURSOR_EXPIRED` / `CURSOR_EXPIRED`: resynchronize authorized Proof snapshots, restart the feed and deduplicate stable event IDs. No silent cursor reset.
- API idempotency results currently retain the stronger existing indefinite replay behavior; business identity and immutable artifact uniqueness are permanent. Sensitive responses are encrypted. No seven-day replay purge is introduced.
- Existing stream guards check at most each 1 MiB or one second while emitting and impose a ten-minute response lifetime. These are bounded exposure intervals, not instantaneous cancellation of bytes already buffered or downloaded.
- All organization source mutations target one merchant per transaction. Any future multi-merchant administrative batch must lock heads deterministically or emit independent auditable transactions.

## Observe and stop

Track current credential/grant denial codes, rate-limit responses, event-head lag, pending/dead webhook deliveries, policy/core recovery lag and `FINALIZATION_CONTEXT_CHANGED`. Existing workers and request/audit tables remain the operational source. Keep secrets, launch fragments, addresses and media out of telemetry. The organization audit endpoint exposes only the current organization's most recent 100 events; full audit-export pagination is deferred.

Stop expansion on crossed tenant data, lost retained recording, altered manifest bytes, incorrect actor attribution or restored authorization discrepancies. Disable the affected organization entitlement and the feature flag; pause affected external delivery where needed. Preserve all evidence, tables and pending work. Disabling the flag stops new organization API admission, but already issued human capture is stopped by disabling the organization or revoking its grant/credential.

Rollback uses configuration first and a compatible application image. A pre-088 image may reject the newer schema due to the existing strict migration compatibility check; do not force it past that guard. Never drop the additive tables, undo revocations, reset manifests or disable immutability triggers to force a rollback. Verify old-client reads and retained media before reopening traffic.

## Remaining release gates

AWS authentication was restored. The initial [read-only inventory](AWS-READINESS-2026-10-20.md) identified the staging-named service as production, with Object Lock absent, durable receipts disabled and Cognito MFA off. Those production resources remain unchanged. Collin then approved the separate synthetic foundation and its 90-day GOVERNANCE retention; that foundation is deployed. Actual storage/signing probes and the private migration runner are documented in the [continuation record](../../infra/partner-foundation/README.md).

Full backend typecheck, 1,396 tests, build and credential/session guards passed on `12dc409e6b602a715d063e13c4ddc45eb2000adb`; 15 tests were skipped. The isolated RDS migration comparison and all seven shared organization/capture/concurrency checks passed on `c03fbf9b6745078fb46a2e3d1b0068bf0d0b8b5e`, with real media validators and preserved before/after archives. The later [protected recovery drill](isolated-recovery-evidence-2026-10-20.json) passed 27 checks with actual S3/KMS/RDS, externally fenced existing sessions and exact manifest/revoked-authority reconstruction. The [test identity pool](isolated-identity-evidence-2026-10-20.json) passed nine required-MFA checks. Temporary runners, IAM roles and egress are removed. These are synthetic coordinator/provider tests; deployed API/worker process separation, authenticated endpoints, actual web/Android sessions and independent M1 review remain open. See [review handoff](RELEASE-REVIEW.md). No named consenting live merchant or live cohort is configured.
