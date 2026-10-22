# Full-release continuation — 2026-10-22

The owner authorized completion of the full release. This supersedes earlier authorization limits; it does not turn incomplete acceptance evidence into a pass. Production has not been changed by this continuation.

## Candidate repairs

Based on PR #108 head `9af5c39c5cc231d5d0fb5df91919783d940aaf63`:

- Restore the remaining-shipment limitation in SIGNAL's compact Proof record and capture screen.
- Restore manual order refresh and give the recommended task its explicit accessible action name.
- Update web expectations to the current SIGNAL navigation, labels and receipt semantics. Supported fallback compositions are selected explicitly in their own tests; SIGNAL remains enabled by default.
- Add simulated-media SIGNAL checks for permission denial, interrupted capture and exact-operation recovery after a lost upload response. These use a real IndexedDB queue with simulated media and transport, and are not device acceptance.
- Repair mobile review-profile assertions to verify that production is unchanged and to check SIGNAL plus both fallback presentations without freezing the current production version number.

The GitHub source files, including fonts and icons, were synchronized to the pinned baseline before testing. Only the reviewed repairs and new evidence are included in the continuation commit.

## Validation

GitHub CI must independently pass on the published candidate; earlier green backend checks do not establish a green full release. Local validation used Windows and Node 22.23.2. Vitest used one thread worker and a writable temporary directory because the default fork pool encountered host temporary-file restrictions.

- Web production build and TypeScript: PASS.
- Web association and Sites routing checks: 11/11 PASS.
- Mobile local-review and startup-profile checks: 8/8 PASS.
- Full web run: 359/360 passed across 62 files. Its sole failure was an account-setup assertion expecting the retired default filter. That assertion was corrected to the current All filter; the complete affected file then passed 9/9. This is a full run plus a focused correction, not a claim of a second clean full run. Clean candidate CI remains required.
- Actual Android device acceptance: not run; `adb devices -l` returned no attached devices.

## Production migration boundary

Source comparison against the previously observed production commit `ccd04aba5b9305ce9bb7b2105323e63f6a95d87a` shows 86 historical SQL migrations unchanged and five additions in the 91-migration candidate:

1. `088_commit_safe_event_stream.sql`
2. `089_partner_organizations.sql`
3. `090_organization_command_results.sql`
4. `091_organization_read_visibility.sql`
5. `092_organization_policy_recovery.sql`

This is a source comparison, not a fresh observation of the live database or running image. Do not infer current deployment state from it.

The existing exact-source release operator is deliberately restricted to the older measurement release. `backend-measurement-inventory.mjs` permits 77 candidate migrations and 76/77 predecessor migrations. `backend-database-preflight.mjs` additionally requires the old staging environment and an exact runtime identity. The workflow does not apply migrations. It cannot deploy this candidate unchanged, and its checks have not been loosened.

## Resume sequence

1. Reconnect the existing AWS app. The attempted read-only ECS inventory returned `UNAUTHORIZED`, `Reauthentication required`, reason `oauth_token_endpoint_unauthorized`, before any AWS API executed. Recheck account, region, service identity, running image digest/source, task and execution roles, database identity, network, secrets references, worker state, protection configuration and CloudTrail. Treat the customer API's historical staging resource names as production resources.
2. Read the actual migration receipts using a TLS, read-only runtime connection. Compare every checksum to the pinned source. Review the five additive migrations against the current database and application roles. No owner secret is to be returned to the operator or logs.
3. Prepare and test an exact-source migration-aware release operator and a rollback-compatible predecessor before changing the live schema. Preserve existing ECS configuration, use a separate narrowly scoped migration execution path, and pin all artifacts. Do not assume the old strict-schema binary will start after the five new migrations.
4. Refresh expired protection evidence and verify its role, resource and source bindings. Resume the isolated environment through `infra/partner-foundation/RUNTIME.md`; it was deliberately paused, with both workload logins disabled and the writer fence closed. Do not initialize a new database against an existing protected journal.
5. Complete the deployed queued-delivery and active-export-stream revocation cases. Run actual web and Android acceptance for permission denial, interruption, process restart, lost upload/finalization responses, wrong-account/Proof resume and local recording retention.
6. Obtain the independent M1-06 review recorded in `RELEASE-REVIEW.md`, bound to the candidate source and evidence digests. The implementer's checks cannot stand in for that independent decision.
7. After exact-candidate CI and acceptance pass, merge and roll out through the reviewed operator. Verify healthy tasks, source/digest, migration receipts, original package bytes, scoped authority and recovery after deployment. Record the release receipt and retain the tested rollback path.

The prior 16-check HTTPS demonstration and two independently verified evidence packages remain useful isolated evidence. They do not establish a live rollout, current protection freshness, physical-device acceptance or consenting merchant adoption. The plan's later demand-dependent milestones retain their stated entry criteria.
