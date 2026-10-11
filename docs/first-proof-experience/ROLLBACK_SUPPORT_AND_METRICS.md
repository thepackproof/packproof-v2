# First Proof experience: rollback, recovery and measurement

## Composition and persisted data

The native opt-in build flag is `EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE=true`; web uses `VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE=true`. False or absent selects the compatible prior presentation. Native flow version is 1; its build-time value cannot change while a running task records, reviews or submits. Task locators record the selected version and remain parseable by the compatible shell. This is a rebuild/redeploy rollback, not an instant remotely operated kill switch.

The old onboarding preferences remain readable. New first-experience fields report authoritative first finalized packing history. A missing, failed or older-server projection is UNKNOWN, never “new account” or “activated.” Tutorial completion is not activation. Voluntary replay remains available.

Native task intents use `packproof.task-intent:v1:<API>:<account>` and carry only route, Proof/invitation/history-share IDs and flow version. Pre-auth record/queue links use an API-scoped pending locator, bound to an account when received while signed in. Locators confer no access. Bearer capture invitation secrets are not written into this general-purpose storage.

The account-scoped draft cache now retains an optional manual operation key, request fingerprint and returned transaction ID. It is persisted before create, retained on failure/restart, and cleared after the server-created Proof and draft handoff succeed. It never substitutes an invented marketplace order reference. Sign-out/account switch removes cached record contents while preserving the original account’s draft/operation in its own namespace. A differently signed-in account cannot hydrate it.

Web draft and creation-operation recovery is independent of the presentation flag. The compatible flag-off shell reads the same account-scoped fields and exact submitted request, including its original idempotency key. If newer form edits differ from an uncertain submitted request, **Recover submitted draft** resumes the original details. Network failures and downstream Proof-creation failures retain that identity; a definite transaction-creation validation rejection can release it for correction.

## Rollback rehearsal

1. Record exact current and fallback artifacts/commits and confirm both use compatible backend contracts. Keep additive preference and transaction retry support deployed.
2. Prepare one reviewed but unsubmitted original, one queued upload and one committed/pending-finalization case under dedicated test accounts. Record Proof and operation identities in private evidence.
3. Build the candidate with the first-proof flag false. Use an in-place supported update; do not uninstall, clear storage or replace journals. Web rollback must keep the same origin/storage context.
4. Open Home/Activity in the fallback. Verify the same account-bound original and operation can be found, reviewed or resumed through existing recovery. A refreshed finalization response, not cached client state, establishes completion.
5. Re-enable the presentation only after the same recovery tests pass. Track any failure with the exact platform and artifact.

The automated browser integration test `web/src/tests/first-proof-rollback.test.tsx` checks flag-off restoration and the exact pending request/key through a simulated downstream failure. A completed physical-device or production rollback rehearsal has **not** been claimed here. A native rollback requires another signed artifact and supported distribution; a JavaScript source flag alone cannot change an already-installed binary. Do not roll backend code back to a version that ignores the new optional transaction creation idempotency key while clients rely on it.

## Support wording and safe recovery

| Observed state | Explain / next action |
|---|---|
| Workspace unknown | “Your records could not be refreshed. Saved work remains available. Try again.” Verify network/session; do not classify as an empty account. |
| Offline before creation | “Connect before creating a Proof. Your entered details are retained.” Creation still requires the server. |
| Original saved, awaiting review | “Recording saved on this device. Review it before submission.” Saving does not authorize upload or finalize evidence. |
| Submission pending | “Keep PackProof open while submission continues. Check Activity for its current status.” Background behavior depends on the OS. |
| Session expired | Sign in to the original account; retain the local file and operation. Revalidate the authorized destination. |
| Unavailable local file | Do not claim it is saved or completed. Inspect existing Activity recovery and authoritative server state before further action. |
| Entitlement failure | Preserve media/draft; show actual server limit and existing supported billing route. Do not promise a free allowance or create a new charge route. |
| Signing cancelled/expired | Retain original, request valid authorization only when required. Do not auto-check or reuse stale consent. |
| Server finalized | Show the returned finalized record and manifest, and its actual access/sharing policy. Upload percentage alone is not success. |

Request app version, platform/OS, coarse network status, step, non-sensitive error category, and whether Activity shows an original. Never request passwords, verification codes, tokens, biometric material or unredacted media/recipient data in a support ticket. Device loss, external deletion and unsupported browser persistence are outside guaranteed recovery.

## Measurement mapping and limits

The primary first-proof release uses the following existing diagnostic sources and seven-day authoritative activation query. Existing `mobile-ux-events.ts` stores session-only counts and bounded durations, with no identifiers, persistence or network transport. Existing native study timing has its own explicit consent, bounded checkpoint schema and account binding. The separate measurement follow-up extends that optional study as described below; neither release silently enables a dataset or grants account consent.

| Plan concept | Existing source | Interpretation |
|---|---|---|
| Entry / selected next action | recommendation_displayed / recommendation_selected | Session events; not unique-account denominator |
| Capture entry overhead | capture_entered | Route entry, not measured camera-ready time |
| Durable local save | capture_durably_saved | Local milestone; not server commitment |
| Review complete | review_completed | Existing review event; do not independently infer consent scope |
| Recovery/intervention | upload_recovery / upload_intervention | Diagnostic aggregates |
| Commit / finalize | commitment / finalization and backend audit | Backend authoritative state is the completion source |
| First finalized packing | Additive onboarding projection/event | Derived from eligible finalized root packing history; sample/tutorial excluded |
| Seven-day account activation | `backend/src/analytics/first-proof-activation.ts`, existing admin Product funnel | Authoritative record query; full observation windows and denominator counts, with eligibility below |
| Consented study | native-study / timing-bridge / shared browser and desktop adapter | Primary task/device/phase schema; follow-up adds the bounded first-experience event family and consented intent cohort, never all-production analytics |

The admin Product funnel now computes seven-day first-packing activation from existing authoritative domain records, without new browser telemetry or a schema migration. The registration cohort includes accounts created in the selected window with a non-development authentication identity, no development identity, and no current system-admin role. Only accounts with seven complete days as of the observation cutoff enter the rate; accounts that never create or finalize a Proof remain in the denominator. Accounts awaiting a full window are reported separately, and an empty mature denominator produces unavailable rather than zero percent. The default seven-day registration window can therefore contain no mature accounts; select a wider or earlier window when reviewing completed observation periods.

Success requires the first eligible seller packing Proof to finalize no later than seven days after account creation, with qualifying committed video, the seller packing declaration and its final manifest. Sandbox, sample, demo, viewer-only and imported-only activity cannot satisfy the numerator. Eligibility uses the same query as the onboarding projection and does not depend on the user revisiting onboarding. Ordinary authenticated internal test accounts still require governed cohort review. The separate “no eligible Proof created” diagnostic measures persisted creation; automatic import creation must not be interpreted as an intentional Create click.

The measurement follow-up adds the complete bounded client event family and the **consented** 24-hour Create-choice report, with actual camera callback timing and authoritative outcome projection. See [MEASUREMENT.md](MEASUREMENT.md) for event triggers, migration 076, cohort definitions, privacy boundaries, operational query, compatibility-image rollout, and explicit unavailable guardrails. A population-wide account-scoped choice timestamp is still not collected; server creation is never substituted for intent. Metrics remain unavailable until the existing governed study configuration and actual account consent exist. Physical readiness and usability results are still pending.

Seven-day metric fixtures cover fully observed cohorts, incomplete windows, late completion, nonstarters, excluded identities and sample activity. These are automated query checks, not measured production activation uplift. Physical camera readiness, device interruptions, screen-reader use and unassisted participant gates remain separate evidence requirements. No activation uplift or numerical performance claim follows from implementation or automated tests.
