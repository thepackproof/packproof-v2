# First Proof experience: rollback, recovery and measurement

## Composition and persisted data

The native opt-in build flag is `EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE=true`; web uses `VITE_PACKPROOF_FIRST_PROOF_EXPERIENCE=true`. False or absent selects the compatible prior presentation. Native flow version is 1; its build-time value cannot change while a running task records, reviews or submits. Task locators record the selected version and remain parseable by the compatible shell. This is a rebuild/redeploy rollback, not an instant remotely operated kill switch.

The old onboarding preferences remain readable. New first-experience fields report authoritative first finalized packing history. A missing, failed or older-server projection is UNKNOWN, never “new account” or “activated.” Tutorial completion is not activation. Voluntary replay remains available.

Native task intents use `packproof.task-intent:v1:<API>:<account>` and carry only route, Proof/invitation/history-share IDs and flow version. Pre-auth record/queue links use an API-scoped pending locator, bound to an account when received while signed in. Locators confer no access. Bearer capture invitation secrets are not written into this general-purpose storage.

The account-scoped draft cache now retains an optional manual operation key, request fingerprint and returned transaction ID. It is persisted before create, retained on failure/restart, and cleared after the server-created Proof and draft handoff succeed. It never substitutes an invented marketplace order reference. Sign-out/account switch removes cached record contents while preserving the original account’s draft/operation in its own namespace. A differently signed-in account cannot hydrate it.

## Rollback rehearsal

1. Record exact current and fallback artifacts/commits and confirm both use compatible backend contracts. Keep additive preference and transaction retry support deployed.
2. Prepare one reviewed but unsubmitted original, one queued upload and one committed/pending-finalization case under dedicated test accounts. Record Proof and operation identities in private evidence.
3. Build the candidate with the first-proof flag false. Use an in-place supported update; do not uninstall, clear storage or replace journals. Web rollback must keep the same origin/storage context.
4. Open Home/Activity in the fallback. Verify the same account-bound original and operation can be found, reviewed or resumed through existing recovery. A refreshed finalization response, not cached client state, establishes completion.
5. Re-enable the presentation only after the same recovery tests pass. Track any failure with the exact platform and artifact.

A completed rehearsal has **not** been claimed here. A native rollback requires another signed artifact and supported distribution; a JavaScript source flag alone cannot change an already-installed binary. Do not roll backend code back to a version that ignores the new optional transaction creation idempotency key while clients rely on it.

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

Existing `mobile-ux-events.ts` stores session-only counts and bounded durations, with no identifiers, persistence or network transport. Existing native study timing has its own explicit consent, bounded checkpoint schema and account binding. These are retained; this change does not silently start expanded production analytics.

| Plan concept | Existing source | Interpretation |
|---|---|---|
| Entry / selected next action | recommendation_displayed / recommendation_selected | Session events; not unique-account denominator |
| Capture entry overhead | capture_entered | Route entry, not measured camera-ready time |
| Durable local save | capture_durably_saved | Local milestone; not server commitment |
| Review complete | review_completed | Existing review event; do not independently infer consent scope |
| Recovery/intervention | upload_recovery / upload_intervention | Diagnostic aggregates |
| Commit / finalize | commitment / finalization and backend audit | Backend authoritative state is the completion source |
| First finalized packing | Additive onboarding projection/event | Derived from eligible finalized root packing history; sample/tutorial excluded |
| Consented study | native-study / timing-bridge | Its approved task/device/phase schema; not all-production cohort analytics |

The seven-day eligible-account activation rate, 24-hour intent conversion, stable deduplicated auth/capture/submit funnel, camera-ready p50/p95, and representative usability thresholds are **not measured by these session aggregates**. Define and approve any expanded telemetry collection/retention before adding it. Keep account eligibility, production exclusions, full observation windows and missing/failing attempts explicit. No activation uplift or numerical performance claim follows from the implementation or automated tests.
