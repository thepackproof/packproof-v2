# Android Phase 1 refinement review

Phase 1 source changes are implemented for the October 16 plan. Local automated checks pass. Native build and physical-device acceptance remain open, so this is **NOT READY for release or Phase 2 acceptance**. Sections 7.1 and 6.2 of the supplied plan require review and acceptance before proceeding to visual polish.

## Changes and task status

| Task | Source result | Device acceptance and remaining evidence |
| --- | --- | --- |
| F1.01 Finalized messaging | Removed the normal finalized-navigation error at its origin; preserved true API errors. Added read-only explanation in Details and corrected banner text flex sizing. | Native long-error and 200% text screenshots pending. |
| F1.02 Next action | Preserved server action labels; added relevant supporting copy, forwarded full-record hints and removed duplicate list status/action text. Existing recovery priorities still distinguish queued, review, submission and completed states. | Home, Proofs and detail comparison pending. |
| F1.03 Photo progression | Existing receipt reconciliation passes partial-save, complete-front/back, lost-response, idempotent replay and account-change tests. No new evidence semantics. | Real camera return, force-stop and relaunch pending. |
| F1.04 Record coherence | Added latest-request guards across Proof reads, dependent transaction/manifest reads, persistence and workspace navigation. Rejects mismatched IDs. Offline views clear unrelated manifest/integrity state. | Rapid-tap native journey pending. |
| F1.05 Recording exits | Existing navigation lock, explicit Back choices, Android lifecycle stop and interruption journal inspected; executable provider navigation tests pass. | Calls, permission loss, backgrounding and native force-stop pending. |
| F1.06 Upload truth | Existing recovery tests pass original retention, receipt-dependent finalization, retry identity, missing originals and changed-account checks. No local completion shortcuts added. | Device airplane-mode / force-stop journey pending. |
| F1.07 Notifications | Explicit account and Proof-ID validation; stale initial-notification callbacks cancelled after cleanup. No fallback record selection. | Push tap after relaunch/account change pending. |
| F1.08 History | Role-specific join title comes from matching server audit metadata. Generic fallback stays Participant. Actor lookup uses exact event ID. Evidence commits no longer assume all media is packing video. | Seller/buyer native comparison pending. |
| F1.09 Media and package | Added explicit loading, ready and failure states for original media. Existing download authorization and package tests pass. | Bright/dark capture, actual playback and Android share-sheet export pending. |
| F1.10 Trust wording | Replaced biometric verification claim with server-verified signing-key signature and explicit client-reported device-authentication limitation. Server signature/biometric-provenance tests pass. | Native attestation view review pending. |

No Phase 2 or Phase 3 cosmetic restructuring was started. The four tabs, capture entry and Proof detail tabs remain unchanged. No backend/API/schema changes, production data writes, merge, deployment or store submission.

## Automated verification

Results in `verification/` record actual local runs, not device acceptance. Counts overlap across suites and must not be summed as unique coverage.

| Check | Result |
| --- | --- |
| Five reproduced pre-change regression cases | 5 failures before fixes |
| Focused Phase 1 and recovery suite | 113 passed |
| Android task-first suite | 110 passed |
| UX recovery and provider navigation | 57 passed |
| Capture recovery and upload handoff | 29 passed |
| Evidence record and scrolling | 25 passed |
| Internal build contract | 8 passed |
| iOS shared-code regression | 76 passed plus configuration/plugin checks |
| Backend finalization, package and attestation | 38 passed |
| Actual provider concurrency and sign-out | 3 passed |
| Mobile TypeScript | Passed |
| Android Metro and Hermes bundle export | Passed on implementation commit 4593ae7; not an APK |

## Review build

The dedicated `Android refinement review APK` workflow uses the exact pull-request head and existing internal-review builder. It checks package identity, source SHA in native config and bundle, local debug signing and 16 KB alignment. It produces an APK plus receipt and logs. A successful build is not device validation.

The existing internal profile is version 1.0.1 / 66 with local debug signing. It is intended for a clean spare device or emulator. It cannot upgrade the differently signed Play installation. Do not uninstall the current app or clear its saved evidence to install it. The implementation was verified locally at commit `4593ae7`, with provider regression evidence added at `6c67aae`. The founder explicitly authorized publication of the review branch and its internal APK build on October 16. Build status is pending. This authorization does not include merge, production deployment or store submission. The CI receipt records the exact published source commit.

## Required Gate 1 review

Use test records and an authorized test account; do not create production test records under this plan. Record the APK hash, device model, Android version and font scale. Exercise two full journeys: ordinary continuous packing through server finalization, and grading front/back capture through acknowledged progression. Include interrupted recording, offline upload recovery, finalized read-only access, exact-ID notifications, actor roles, media playback and package contents.

Attach matched native screenshots and short videos to the review. Record actual PASS or FAIL for each device scenario. Current screenshots in the supplied plan establish the visual baseline only; no after-screenshots or device passes have been fabricated. After the Phase 1 gate is accepted, continue with Phase 2 tokens/components and then the separately reviewed Phase 3 spacing matrix.
