# Capture contract and implementation evidence

October 11, 2026. This record describes source changes and automated evidence in the first-Proof implementation checkout. It does not establish a deployed backend, signed binary, installed application, physical camera or participant result.

## Authoritative operation

The server issues a capture session after checking existing account eligibility and reserving allowance for that Proof. Native and browser recorders now require the issued session's positive `maxRecordingBytes` and `maxRecordingSeconds`; missing or invalid limits fail before recording and cancel the unused session. Both recorders enforce the lower of the issued allowance and the existing platform safety cap. The native bridge advertises support for per-session limits. An older installed bridge may still use the existing standard cap, but refuses a session with a lower account cap until the binary is updated.

The camera displays the applicable duration and size before recording, keeps the essential continuous-recording reminder visible, and counts down against the actual duration cap. A limit interruption remains an interrupted recording requiring review. The change does not turn an interrupted take into a submitted or finalized Proof. Notification permission is no longer requested automatically after submission.

The existing durable completion coordinator remains the owner of original-file persistence, upload handoff, explicit declaration/signing, evidence commitment, and finalization reconciliation. A saved local original, an uploaded object, a committed evidence row, and a finalized Proof remain distinct milestones. Retrying keeps the same account, Proof and capture identity. Account changes are rechecked between external effects.

## Allowance reservation, retry and cancellation

Existing policy reserves allowance per Proof, not per recording attempt. `billing_capture_reservations` has an immutable Proof key and a database trigger rejecting updates/deletes. Cancelling an unused capture session releases that session so another can be issued; it does **not** delete the Proof reservation. Retakes/retries reuse that reservation. Finalization accounting unions the reservation, usage receipt and canonical finalized Proof so the same Proof is counted once. This implementation preserves that policy rather than inventing a refundable reservation transition.

The desktop recorder retains its existing offline contract and encrypted local originals. Its later server registration can return an account restriction. The first-use UI must not claim that a local desktop capture is a server entitlement approval or finalization. The web/native paths obtain the actual issued-session limits before recording.

## Automated evidence

| Executed scope | Result |
|---|---|
| Native `capture-limits`, `capture-recovery`, `upload-handoff` after security follow-through merge; included in `test:recovery` CI script | 29 passed |
| Web `web-camera-redesign`, central capture recovery and packing-station tests | 20 passed |
| Web `intake-integration` and `web-camera-redesign` after issued-session fixture corrections | 19 passed |
| Web `app.test.tsx` after issued-session fixture corrections | 35 passed |
| Backend `billing-enrollment`, `redesign-integrity`, `durable-recovery`, `fulfillment-capture`, `mobile-attestation-authorization` | 43 passed |
| Web TypeScript check | Passed |
| Backend release request construction, pinned image-origin checks and CANARY service-revision reconciliation | 31 passed |

The capture-limit regressions cover invalid/missing limits, lower account limits, platform-cap clamping, older native bridge compatibility, browser stop-on-limit, and cancelling an unused invalid session. Existing recovery tests exercise durable handoff and reconciliation independently of this UI work. Native Kotlin/Swift changes require compile evidence from the final candidate; no physical camera claim follows from the TypeScript/model tests.

## Release dependencies and separate acceptance

The backend release route pins the reviewed main commit, exact archived backend bytes, immutable image, current predecessor and reviewed network topology. It preserves service configuration and migration policy. Its read-only database verifier requires all 76 migration receipts, including `075_onboarding`, for the primary compatibility image; the measurement follow-up requires all 77, including `076_first_experience_measurement`; a missing onboarding migration is a release stop. Discovery, database verification, deployment and public postchecks each need their own successful receipt.

Permission revocation, force-stop during camera recording, device storage exhaustion, biometric cancellation, operating-system suspension and account switching with a real queued original remain installed-device acceptance work. The Galaxy S24 Ultra steps and T01–T28 mapping are in `ACCEPTANCE_AND_DEVICE_CHECKLIST.md`.
