# PackProof RC1 Release Gate

PackProof RC1 is the point at which the current V2 architecture is treated as release-candidate evidence infrastructure rather than a feature-development environment.

A release must not be promoted merely because it builds. Every mandatory gate below must have an owner-visible pass result for the exact Git commit being released.

## 1. Repository and release identity

- [ ] `main` is protected against direct pushes.
- [ ] Pull requests are required for `main`.
- [ ] Backend, Web, Mobile, and security checks are required and green.
- [ ] The release commit SHA is recorded and returned by `GET /meta`.
- [ ] The deployed image/tag corresponds to that exact SHA.
- [ ] Android versionCode/versionName and web/API release identity are recorded together.
- [ ] No credentials, provider tokens, signing material, or environment secrets exist in source control.

## 2. Evidence integrity

- [ ] Evidence is uploaded independently of DB commitment.
- [ ] Server independently computes SHA-256 from stored bytes before commit.
- [ ] A changing S3 upload fails the ETag/If-Match commit boundary.
- [ ] Committed evidence uses content-addressed keys.
- [ ] Reading committed evidence rechecks the key-embedded SHA-256 and fails closed on mismatch.
- [ ] DB mutation of committed evidence is rejected.
- [ ] Finalized Proof mutation guards pass.
- [ ] Canonical manifest is deterministic and idempotent.
- [ ] Manifest SHA-256 reproduces from canonical JSON.
- [ ] When signing is enabled, the signature is written on the original immutable manifest INSERT; signatures are never attached later.
- [ ] Portable Proof-package verification detects canonical JSON, digest, and signature tampering.

## 3. Evidence storage durability

The repository template is not evidence that the deployed bucket has these settings. Verify the actual bucket used by the release.

- [ ] S3 versioning is `Enabled`.
- [ ] S3 Object Lock is enabled for the production evidence bucket.
- [ ] Default retention mode and duration match the approved policy.
- [ ] Public access is fully blocked.
- [ ] TLS-only bucket policy is active.
- [ ] Runtime task role has no routine evidence delete permission.
- [ ] Pending-upload lifecycle behavior cannot delete a committed content-addressed object.
- [ ] A restore/read exercise has proven that a committed historical object version can be retrieved.

## 4. Database and recovery

- [ ] Production PostgreSQL is private and encrypted.
- [ ] Multi-AZ is enabled.
- [ ] Deletion protection is enabled.
- [ ] Automated backups meet the approved retention period.
- [ ] Point-in-time recovery window is confirmed.
- [ ] A restore drill has been completed from an actual production-like backup.
- [ ] Migration 001 through the current migration all apply successfully to an empty database.
- [ ] Migrations also apply successfully to a copy of the current staging schema/data.
- [ ] Restored data reproduces stored manifest hashes for sampled finalized Proofs.

## 5. Authentication and authorization

- [ ] Cognito is the only release authentication mode.
- [ ] Dev login is disabled.
- [ ] User identity survives app restart and expired-session recovery behaves correctly.
- [ ] A seller cannot access another seller's unauthorized Proof.
- [ ] A public access token grants only its explicit read scope.
- [ ] Revoked and expired access links fail closed.
- [ ] Public access links do not expose provider credentials or internal-only metadata.
- [ ] Client applications cannot directly set authoritative Proof status.

## 6. Provider and webhook safety

- [ ] eBay account-deletion challenge response passes provider verification.
- [ ] Every eBay deletion POST requires a valid `X-EBAY-SIGNATURE` before any account mutation.
- [ ] Invalid/missing signatures return a failure and make no state change.
- [ ] eBay public-key verification failure fails closed.
- [ ] Shopify webhook verification remains enabled for webhook-driven mutations.
- [ ] Provider OAuth tokens remain server-side only.
- [ ] Provider disconnect/revocation paths remove or disable stored credentials as designed.
- [ ] Integration failure never rewrites canonical Proof identity.

## 7. Workflow semantics

- [ ] Every new Proof stores an immutable workflow version.
- [ ] `COMMERCE_SALE v1` semantics remain regression-tested.
- [ ] `GRADING_SUBMISSION v1` semantics remain regression-tested.
- [ ] Unknown workflow versions fail closed.
- [ ] No new workflow is introduced without a versioned registry definition and tests.
- [ ] Existing finalized Proofs are never reinterpreted when a future workflow version is introduced.

## 8. End-to-end commerce smoke test

Run this against the exact release candidate deployment.

- [ ] Create/sign into seller account.
- [ ] Connect or import from a supported commerce provider, or create the equivalent transaction directly.
- [ ] Confirm transaction identity and external provenance.
- [ ] Create/get the single Proof for that transaction.
- [ ] Complete seller fulfillment capture.
- [ ] Interrupt/retry one upload and confirm the same evidence identity is preserved.
- [ ] Commit evidence and verify the server hash.
- [ ] Complete packing attestation.
- [ ] Attach/observe shipment context where available.
- [ ] Finalize the Proof.
- [ ] Repeat finalize and confirm the same manifest identity/hash.
- [ ] Open the Proof from web and Android and confirm the same authoritative state.
- [ ] Open a scoped public Proof link and verify the intentionally limited projection.
- [ ] Download/export a Proof verification package when that release feature is enabled and verify it independently.

## 9. Physical two-user/two-device regression

- [ ] Seller: primary Android device.
- [ ] Counterparty/second user: separate physical Android device.
- [ ] Invitation/optional-counterparty behavior matches the workflow policy.
- [ ] Both devices converge on the same server-authoritative Proof state.
- [ ] App force-stop/restart does not lose discoverability of an authorized Proof.
- [ ] Back navigation does not corrupt capture state.
- [ ] Temporary network loss during capture/upload is recoverable without duplicate committed evidence.
- [ ] Android gesture navigation and 3-button navigation both remain usable.
- [ ] Light and dark themes remain usable on the release build.

## 10. Operational visibility

- [ ] API health endpoint is monitored.
- [ ] API 5xx and latency alarms are configured at the deployed ingress/service layer.
- [ ] RDS CPU/free-storage alarms are configured.
- [ ] ECS/container logs have an approved retention period.
- [ ] Database connection saturation can be detected.
- [ ] Release identity is included in incident/debug output.
- [ ] An operator can distinguish provider outage, database outage, S3 outage, auth failure, and integrity rejection.

## 11. Beta-ready decision

External seller beta can begin only when all P0 integrity, storage, auth, provider, recovery, and release-identity gates above pass. Cosmetic defects that do not alter evidence meaning may be accepted explicitly; integrity ambiguities may not.

The beta wedge remains intentionally narrow: high-value seller fulfillment evidence. New workflow categories or marketplace integrations must not delay correction of an RC1 release blocker.
