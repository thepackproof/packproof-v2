# PackProof administration implementation

Prepared 2026-09-24. Code is implemented locally; **it is not deployed and the initial administrator role has not been granted**. This document records the delivered behavior and the remaining release work, rather than asserting that every example in the development plan is available.

## Delivered behavior

| Area | Implementation |
| --- | --- |
| Authorization | Database-backed `SYSTEM_ADMIN`, checked on every `/admin/*` request. Ordinary users receive 403; unauthenticated requests receive 401. `/me/capabilities` controls navigation. No email-based runtime authorization. |
| Administration workspace | Dedicated `/admin` shell, 11 primary sections, global search and keyboard shortcut, reporting periods, previous-period comparisons, paginated tables, record details, copied IDs, responsive layout, dark mode, and loading/error/empty states. |
| Overview | Recorded business activity, health observations, attention items, selectable usage chart and accessible data table, and an activity feed with pause, filter, and automatic refresh. |
| Investigation | Users, Proofs, evidence, connections, webhooks, billing, grouped failures, security events, and immutable administrative history, with links to related records. |
| Evidence integrity | Read-only per-Proof checks of manifests, references, object versions, sizes, and hashes, returning PASS/WARNING/FAIL with technical detail. Requests have object, byte, time, and concurrency bounds. Finalized evidence has no administrative edit endpoint. |
| Analytics | Recorded product funnel stages, usage, registration cohorts, returning creators, daily public page/click/device totals, and authenticated client release observations. Values disclose their source and limits. |
| Infrastructure | Database/storage probes, worker observations, and optional scoped CloudWatch metrics, alarms, and Cost Explorer adapter. AWS data uses bounded reads, caching, explicit resources, and observation timestamps. |
| Safe controls | Disable/re-enable accounts, invalidate sign-ins and intake sessions, adjust eligible billing allowances, disconnect local integration use, retry supported failed sync/webhook work, triage errors, pause registration, and pause new captures. |
| Audit | Immutable events and receipts, reason and typed confirmation for changes, expected-version checks, idempotency, atomic accounting changes, and recent authentication for production mutations. |
| Bootstrap | Separate operator-only command verifies the internal user, Cognito subject, verified contact, and active account before granting the initial role. Role assignment is unavailable through profile and admin HTTP APIs. |

## Source and feature limits

- Website instrumentation stores daily aggregates without tracking identifiers. It does not establish unique visitors, sessions, referrers, geography, or visitor-to-registration attribution. Product funnel stages are recorded account activity; they are not an attributed advertising funnel.
- Client release observations are client-reported and only begin after instrumented clients ship. They do not establish installed population, verified operating systems, deployment time, or per-version error rates.
- Security views expose recorded administrative actions, disabled accounts, and session revocations. Cognito login/reset/verification logs and historical rate-limit trends are not connected. Existing Cognito MFA policy is unchanged.
- Billing uses the existing consented allowance model. Adjustments append to an immutable ledger; there is no invented prepaid credit wallet, payment provider, or revenue data.
- Integration data describes recorded connections and operations. Complete provider request latency/success rates and unsupported reconnect/replay controls remain unavailable.
- Integrity checks inspect known references. Bucket-wide orphan inventory, complete upload-duration/processing telemetry, automatic cleanup, and a frontend exception feed are not implemented.
- Admin password reset, verification resend, account deletion, support notes, integration re-enabling, retention changes, and generic job/cache controls were not added. Existing user-facing workflows remain separate.
- AWS metrics require the explicit resource selectors and read permissions documented in `ADMIN_AWS_METRICS.md`. No live AWS settings or credentials were changed.

## Validation

- Current Sites web: 259 tests across 45 files passed, plus 11 association/worker checks. Both web checkouts pass typecheck; the production web build passes. Subsequent admin/routing smoke checks passed after release telemetry was added.
- Backend: all 45 focused admin tests passed (authorization/actions, integrations, reads, infrastructure/AWS, and release observations). Typecheck and production compilation pass.
- Mobile: six release-reporting tests and typecheck passed. Native release reporting requires a newly shipped app; no store build or submission was performed.
- Recovery: the full regression run exposed a compatibility issue with newly seeded flags. The fix admits only the exact untouched migration defaults. All seven recovery tests pass, including rejection of used databases, altered flags, and missing seeds.
- Broad backend regression: 1,020 passed and six recovery failures were found. All seven recovery tests passed after the fix (including the new seed-guard case). Two additional suites initially could not load local mobile dependencies; all 15 tests passed after those dependencies were supplied. Combined coverage is **1,042 passing tests across 136 suites**, with no unresolved test failures. Twelve opt-in checks across the suite remain skipped because live services or real PostgreSQL pools were not configured. This is the full run plus focused retests, not a claim that the original failing command returned success.
- An independent security review checked authorization, immutability, sensitive projections, and mutation audit coverage. Local browser checks used disposable data produced by the real admin API; temporary fixture entry points were removed.
- Live PostgreSQL runtime grants, AWS selectors, production probes, and administrator bootstrap remain unverified.

## Release status

The GitHub checkout and current Sites checkout have different existing application histories, including different Expo SDK versions. Admin changes have been applied to each without replacing the newer live-site work. Local commits are the reviewable delivery; no remote branch, pull request, or deployment is implied.

An automatic approval review rejected even a GitHub push dry run because publishing private repository contents was not considered authorized by the implementation request. No alternative publishing route was used. Explicit authorization is needed before pushing to `thepackproof/packproof-v2` and publishing the updated website.

The read-only AWS inventory did not return, so current service configuration, database identity/privileges, recovery state, and Cognito bootstrap identity remain unverified. Backend deployment and administrator assignment require a working authenticated AWS/operator connection.

Follow `ADMIN_DEPLOYMENT_RUNBOOK.md` for the compatibility bridge, pinned additive migrations, separate runtime credentials, image-only rollout, verified bootstrap, and production checks. Follow `ADMIN_SECURITY_OPERATIONS.md` for authorization and control semantics. Publishing the frontend by itself does not complete the backend release.

## Reviewed implementation commits

| Checkout | Local implementation commit |
| --- | --- |
| GitHub source branch `codex/packproof-admin-dashboard` | `eb845c1d020a595ec0fba0f88060a6e3d2c90354` |
| Current Sites source | `3cdf8bb5073ec72e26f3ee4b6339ee0b634ae588` |

These identify the tested code. A later documentation-only commit records these validation results. Neither source has been pushed or deployed.
