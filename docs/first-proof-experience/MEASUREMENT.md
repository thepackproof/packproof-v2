# First-experience measurement implementation

This extends the existing optional capture timing study. It does not enable a dataset, grant consent, or collect all-customer navigation. Existing session-only mobile UX counters remain a separate source. No recording, item text, label value, address, email, credential, biometric data, or domain identifier is admitted in study payloads.

## Collection and event identities

Collection requires the existing `PACKPROOF_STUDY_ENABLED=true`, provisioned study dataset, matching key version and dedicated analytics key configuration, and an actual current account/dataset grant to `capture-timing-study-v1`. Missing configuration reports unavailable. The Settings study panel is visible only when the service supplies a study. Joining remains an unchecked, explicit action; withdrawal stops future intake and discards unsent journals on the next consent check.

Clients project only allowlisted fields before local persistence. Flow version is 1. Platform, app version, entry category, phase, coarse online/offline/unknown state, bounded error categories and finite worker states are optional metadata. Client versions and clocks are self-reported. Account/API scope binds local journals, capture locators and APIs. Local task/Proof locators never enter study payloads.

Every journal start and checkpoint persists a cryptographic operation nonce. Intake derives stable account/dataset HMAC identities; identical retries replay, changed facts reject. Actual callback timestamps are taken synchronously before optional async preparation. Local checkpoint serialization is independent of remote consent/intake latency. Only one remote flush runs per journal, preserving checkpoint order and original operation IDs. Finite once-only lifecycle keys survive local restart. A task has a bounded 250-row lifetime and retains a terminal slot; long or unavailable-device observations are incomplete rather than invented.

| Event | Actual source |
|---|---|
| `entry_viewed` | Authenticated entry view, with existing consent; public entry is unmeasured |
| `start_selected` | Intentional Create / specific packing choice; the original synchronous timestamp survives camera navigation and local recovery |
| `auth_started`, `auth_failed`, `auth_completed` | A previously consented account's reauthentication lifecycle; bounded local buffer sends only on authenticated return to that same account; no fresh-account or email telemetry |
| `capture_ready` | Browser rendered preview frame with positive dimensions and active stream; native actual camera-ready callback; desktop actual camera-ready callback |
| `capture_started` | Recorder/native recording callback, not route entry |
| `capture_saved` | Successful local durable save acknowledgement, not in-memory video availability |
| `capture_interrupted` | Actual recording interruption callback/state; absence of a terminal event is not a crash |
| `submission_authorized` | Explicit valid recording authorization persisted by the existing submission flow; required signing remains in force |
| `upload_state_changed` | Material worker states (`queued`, `uploading`, `waiting`, `retrying`, `committing`, `finalizing`, `complete`, `needs_attention`) |
| `help_opened`, `hint_dismissed`, `recovery_action` | Voluntary help/dismissal or attempted recovery; interface actions do not create packing-task denominators |
| `evidence_committed`, `proof_finalized` | Read-only backend projection of canonical eligible history, with stable server event IDs. Client intake rejects both names |

The public sample never starts collection, a packing attempt, evidence, credits or activation. A signed-in, already consented sample opening can be a help action. Desktop uses `platform=desktop` and the legacy device class `unknown`; that does not classify it as a measured phone model.

## Cohort and operational query

Authenticated SYSTEM_ADMIN callers can read `GET /admin/analytics/first-experience?period=30d`. It uses the existing admin time-range parser and 30-second cache. The Product analytics view exposes the same 24-hour conversion rate. The source query is `backend/src/analytics/first-experience-report.ts`; no raw account or Proof IDs leave that report.

The first `start_selected` for a packing task with flow version 1, across the dataset's entire prior history, defines account entry. Retried operations and later devices do not add accounts. The report then applies its selected cohort interval. Eligible accounts have a non-development identity, no development identity and no current SYSTEM_ADMIN role. Any eligible packing finalization before entry excludes a previously activated account. Ordinary-login internal test accounts still need governed cohort review.

An account enters the 24-hour rate only after its full window has elapsed. Failures, abandoned tasks and starts with no terminal event remain in the denominator. Withdrawal before the full window is counted separately as censored. Zero mature accounts yields an unavailable rate, not zero percent. Never-started accounts remain visible in the separate seven-day registration activation report; this consented intent report cannot represent them or claim all-user conversion. Read `eventCountsPopulation` before comparing event counts: eligible first-choice accounts include immature and censored cohorts, while conversion and retry/intervention rates use fully observed accounts.

The four stages are client-reported durable save, client-reported authorization, authoritative committed capture and authoritative finalization. A qualifying committed capture requires the seller's `COMMITTED` video of type `FULFILLMENT_CAPTURE` and a qualifying origin; its timestamp is actual `MIN(e.committed_at)`, not Proof creation or attestation. Finalization additionally requires the canonical finalized record, manifest and seller packing declaration. Sample, demo, sandbox, receiving-only and viewer activity are excluded by the shared eligibility query.

Choice-to-ready and choice-to-recording p50/p95 use exact reported callback timestamps on the same task. Foreground and offline observed durations are reported separately. Foreground time includes human effort and OS prompts; it is not app-controlled overhead. Closed-process time is not manufactured as foreground time. Controlled physical tests must still separately record authentication wait, OS prompts, packing duration and app-controlled overhead before evaluating design budgets.

Guardrails report consented recovery accounts, recovery followed by authoritative finalization within 24 hours, intervention accounts and reported integrity errors. Root Proof and billing usage uniqueness are named database invariants, not a claim that semantic duplicate shipments or payment-provider charges have been measured. Payment charges require existing ledger/provider reconciliation. Crash rate and acknowledged-media loss remain explicitly unavailable: a missing event cannot prove either. Their device/provider reconciliation evidence remains a separate release/operational gate. No baseline, uplift, statistical significance or physical latency pass is inferred from these automated tests.

## Migration, rollout and rollback

`076_first_experience_measurement.sql` adds nullable bounded metadata columns, extends the interaction constraint and adds a partial choice index to existing immutable study tables. It creates no grant or dataset. Exact Git LF-byte SHA-256: `3b80452692918bb3589500d100b773deeb8cddf3c57b6882796e8cd1a13c1157`. The SQL is frozen; changing it requires a new reviewed migration.

The backend rejects migration receipts outside its compatibility envelope. Therefore a pre-076 image cannot simply be used after 076. The reviewed rollout uses an intermediate primary image that accepts only the exact 076 receipt/checksum while retaining earlier behavior, followed by the 076 migration and measurement image. Verify `/ready` on the primary image before and after migration, then on the measurement image. The exact-checksum intermediate image is the rollback target; do not weaken unknown-migration checks or delete receipts. Keeping measurement disabled on a schema-aware image is also supported. Existing evidence/signing/billing behavior is unchanged.

Client rollback keeps account/API journals and local media. Build flags can restore prior presentation, while compatible timing intake continues to accept old clients omitting new fields. Do not clear device/browser storage to perform a rollback. Physical installed-binary recovery/rollback and real study configuration are not proven by local source tests.

## Automated evidence

- Backend typecheck; focused first-experience cohort, study intake, observation export and seven-day activation suites: 16 tests passed before the final guardrail extension; final cohort rerun passed afterward.
- Browser full suite: 57 files / 321 tests passed, plus 11 association/worker tests. Latest typecheck and study/actual-frame tests passed after the final local-journal changes.
- Shared durable timing bridge: 13 tests passed, including lost acknowledgements, account changes, withdrawal, sanitized restoration, exact choice time and a pending remote consent request that cannot delay a durable camera callback.
- Native and desktop evidence is recorded by their implementation checks. These source/runtime checks do not establish Galaxy S24 Ultra performance, iOS background behavior, physical media-loss recovery or unassisted participant results.
