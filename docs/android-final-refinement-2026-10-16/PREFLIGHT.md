# Android final refinement preflight

The October 16 three-phase plan is being implemented in sequence. Phase 1 corrects behavior in the existing Android experience. Its review gate precedes Phase 2. Production, store submission, web deployment and automatic merge are not authorized by this plan.

## Baseline

- Branch: `ux/android-final-refinement-2026-10-16`.
- Source baseline: `83d5ce36fdf6cea3420ec44f566e1d3c9a494283`, fetched from `thepackproof/packproof-v2` main on October 16.
- Repository production configuration: Android 1.0.1 / versionCode 68. The nine embedded screenshots do not include installed build provenance; their exact binary cannot be established from the document. They are visual references, not device test results.
- Existing internal review configuration: 1.0.1 / 66, APK, Android task-first and first-Proof experience enabled, Cognito authentication, research production features disabled. It uses the configured API endpoint. Building does not create or modify server records.
- Review workflow builds the exact PR head using the existing local-review builder. No store signing, deployment, production data operations or submission steps.

## Observed code paths and diagnosis

| Tasks | Source of truth and path | Observed finding |
| --- | --- | --- |
| F1.01 | `freshProofDestination` → provider `notice: setError` → `ErrorBanner` | Normal finalized access generated a red error. Nested banner text used vertical flex, consistent with clipped text. |
| F1.02 | Server `presentation.nextAction`; native `home-adapter`, recovery selector and `MyProofsScreen` | Workflow reasons were generic; list concatenated identical status and action strings. Full-detail server hints were dropped in the local summary projection. |
| F1.03 | `photo-draft-model`, `PhotoCaptureFlow`, `commitGradingCapture` | Existing code retains local slots, checks server receipts and replays the same action key after response loss. Existing tests cover acknowledgement and lifecycle recovery. Physical-device results are not established. |
| F1.04 | Provider `refreshProof` / `openProof`, `action-routing` | Fresh account checks existed, but no request-generation guard stopped older responses from replacing a newer selection. Transaction and manifest IDs were not checked as a single snapshot. |
| F1.05 | `NativeCaptureHost`, provider capture navigation lock, Android `UnifiedCameraView` | Existing Back choices and lifecycle interruption stop the take and retain recovery metadata. Native hardware, incoming calls and force-stop behavior require device verification. |
| F1.06 | Recovery journal, upload coordinator, server receipt/finalization | Local capture, upload, commit and finalization are separate. Existing recovery tests retain originals until the required receipts, including lost responses. |
| F1.07 | `NotificationBridge`, account-scoped payload, deep-link parser | Exact IDs existed. The asynchronous initial notification callback could outlive its account effect; added cancellation and explicit payload validation. |
| F1.08 | Server audit `events[].actorUserId` and `data.role`; mobile chronology mapping | Mobile mapped every participant join to Buyer, including the server's SELLER creation event. Related entity IDs were also accepted as actor-event matches. |
| F1.09 | `ProofEvidencePreview`, authorized original-content endpoints, `EvidencePackageButton` | Playback had error/retry handling but no explicit loading state. Dark screenshot alone does not demonstrate corrupt media. |
| F1.10 | `attestation-authorization.ts`, server receipt `signatureVerification` and `biometricMethodProvenance` | Server verifies an ECDSA signing-key signature, explicitly not independent biometric provenance. Mobile overstated this as a verified biometric signature. |

## Preserved contracts

No server, schema, evidence semantics, canonical manifest, billing, retention or primary navigation changes. Proof identity, server authorization, immutable evidence and idempotency remain authoritative. Mobile shared behavior requires iOS regression checks. Web and desktop source files are unchanged.

## Unverified acceptance

No local Android SDK, adb, emulator or attached device was found; local Expo CLI is not signed in. The founder authorized publishing the review branch and running its internal build on October 16. Draft PR #102 publishes the implementation and tracks the build-only CI results. Device results remain pending. Matched native screenshots, TalkBack, 200% text, keyboard/navigation modes, real camera/mic interruption, force-stop recovery, and two complete device journeys remain required before Phase 1 acceptance. No mockup is presented as implementation evidence.
