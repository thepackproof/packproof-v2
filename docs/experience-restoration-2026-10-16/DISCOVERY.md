# Source discovery and preservation map

This audit is grounded in commit `80b83b10a0f2d8c2dc30f7c2eb642e3b4979b0b4`. It is a source audit, not a claim that screenshots demonstrate backend behavior.

## Actual architecture and state owners

| Concern | Existing source of truth | Required presentation treatment |
| --- | --- | --- |
| Proof and transaction identity | `mobile/src/app/PackProofProvider.tsx`, `experience/proof-request.ts`, `experience/action-routing.ts`; server domain commands | Keep explicit requested Proof identity and newest-request guards. A catalog row cannot replace the authorized full record. |
| Ordinary sale requirements | `backend/src/domain/finalize.ts`, `canonical-proof.ts`; `capture/completion.ts`, `attestation/statement.ts` | One continuous fulfillment recording plus the existing declaration and secure confirmation. Do not add universal front/back photos. |
| Grading requirements | `copy/custody.ts`, `capture/photo-draft-model.ts`; server `nextAction.captureRecipe`, asset and transfer IDs | CARD_STANDARD_V1/CARD_DETAILED_V1 expose required FRONT/BACK views. PACKING_STANDARD_V1 is video. Other steps and actor roles remain server-controlled. |
| Photo acceptance | `capture/photo-drafts.ts`, `photo-draft-model.ts`, provider `retainGradingPhoto` | Persist the exact context and file before counting it. `LOCAL_ONLY` is not server-saved. Replacement retains the prior original until safe. |
| Photo submission | `submitPhotoDraft`, provider `commitGradingCapture` | `SUBMITTING` persists before network work. Each receipt is validated; task `apply` is separate from file commitment. A lost response replays the same action identity. |
| Video capture | `NativeCaptureHost.tsx`, `capture.ts`, native `packproof-unified-camera` module, `capture/engine.ts` | Keep native source identity, interruption journal and explicit stop/finalize semantics. Do not remount the camera for animations. |
| Transfer/recovery | `capture/recovery-model.ts`, `recover-completion.ts`, `completion.ts`, `upload-recovery.ts` | Distinguish LOCAL_ONLY, UPLOAD_QUEUED, UPLOADING, BYTES_RECEIVED, PRESERVATION_PENDING, CONFIRMATION_NEEDED, FINALIZATION_PENDING, SUBMITTED and FINALIZED. Unknown responses require reconciliation. |
| Safe cleanup | `mayCleanUpCapture` and matching preservation/finalization receipts | No animation, thumbnail, percent or screen unmount can delete original media. |
| Shared next action | `experience/recovery-workspace.ts`, `home-adapter.ts`, `proof-detail-model.ts` plus grading server action | Preserve rank and exact-session recovery. Consolidate presentation without inventing policy. Historical nonblocking files remain discoverable separately. |
| File persistence and availability | `proof.evidence[].validationStatus`, evidence ID/hash, local file inspection, account/API scope | A missing local original is different from server commitment, no access, offline availability or an original on another device. Warnings name the file. |
| Participant state | `proof.participationPolicy`, participants, invitations and current next action | COUNTERPARTY_OPTIONAL does not block sender work. Required participant prerequisites follow actual server policy. Waiting for a participant does not negate saved files. |
| Finalization | `backend/src/domain/finalize.ts`, validated Proof/recovery response | No client status mutation. Root finalization, receipt stages and participant actions remain distinct. |
| Navigation/notifications | `app/navigation.ts`, `notifications/destination.ts`, `NotificationBridge.tsx`, provider navigation lock | Resolve the explicit account and Proof. Do not navigate away from an active recorder. Restore source and selected artifact on return. |
| Theme and motion | `theme/tokens.ts`, `ThemeProvider.tsx`, `theme/motion.ts`, `ui/motion.tsx`, `theme/haptics.ts` | Existing Inter, Animated and AccessibilityInfo suffice. No new font, navigator or animation dependency is needed. Preserve stored appearance choices. |

The current seller declaration is: **The item shown and attached in this Proof is the item I am shipping** (version 1). The prototype builder reads that exact string from `mobile/src/attestation/statement.ts`. Production must continue to use the current declaration owner and secure signing flow.

## Baseline issue evidence

| ID | Source finding | Work or remaining reproduction |
| --- | --- | --- |
| B01 | `recovery-presentation.ts` uses a generic original-unavailable title. `ProofDetailScreen` renders older photo drafts above the record. | Candidate scopes messages to files. Verify actual file availability and severity on devices before changing production priority. |
| B02 | `PhotoCaptureFlow` durably retains photos; `CaptureScreen` has deliberate review and retake. | Preserve these owners; candidate shows each accepted view and keeps record acceptance separate from finalization. |
| B03 | `SignatureProofScreen` has five tool destinations; `ProofRecord` has a separate three-tab strip. | Proposed top level Capture/Record/Tools, with the tool routes and details preserved below. No old route removed at this checkpoint. |
| B04 | `ProofDetailScreen` More actions groups distinct handling, custody and technical actions with repeated row treatment. | Candidate task rows and grouped Details; parity map below prevents hiding functions. |
| B05 | `VideoReview` delegates controls to expo-video; `ProofEvidencePreview` already has explicit media states. | Actual one-second/long-video metadata, seeking, bookmark and aspect-ratio checks remain pending. No duration bug inferred from a screenshot. |
| B06 | Motion components exist, but not all task transitions use them; scan feedback effect did not respond to a changed reduced-motion value. Recording-start and barcode callbacks called haptics during recording. | Added capture-wide asynchronous feedback silence, removed recording-start vibration, made scan animation respond dynamically. Candidate demonstrates persistent state plus motion. |
| B07 | Current native baseline is the task-first cool palette. September 8 repository assets preserve an earlier paper identity. | Candidate neutral palette is a reconstruction informed by authentic history; no claim of exact Zite restoration. |

## Routes and feature parity proposal

Every route in `AppRouteName` remains in the application. This table is a proposed destination mapping, not approval to remove an old path.

| Current routes or capability | Source owner | Proposed destination / preserved behavior |
| --- | --- | --- |
| boot, auth, sample | Root, AuthScreen, SampleProofScreen | Existing shell and authentication; intended order/invitation remains bound through verification. Sample stays labeled. |
| home, proofs | AndroidTaskHomeScreen, MyProofsScreen | Home / My Proofs; start, exact pending task, full catalog, filters and remembered state. |
| orders, station, scan, intake | WorkspaceOrdersScreen, PackingStationScreen, ScanScreen, OrderIntakeScreen | Start/import order; existing scanning, marketplace exceptions, station batches, manual fallbacks and context retained. |
| create, manual, review | CreateScreen, ManualCreateScreen, PurchaseReviewScreen | Required task/order setup; idempotent existing transaction/Proof; optional metadata deferred. |
| proof, capture, finalize, complete | ProofDetailScreen, CaptureScreen, FinalizeScreen, provider completion | Capture journey and completion summary. Current recipes, native confirmation, recording lock, recovery and finalization guards retained. |
| proof evidence files, original player, bookmarks | ProofRecord, ProofEvidencePreview, SignaturePlayer | Record, with actual file state and exact original/time; retain selected source and playback return state. |
| signature / replay | SignatureProofScreen | Record original viewer; old signature entry can redirect while retaining source IDs and annotations. |
| signature / ask | SignatureProofScreen, `signature/workflows.ts` | Tools / Find evidence; existing query command and source-linked results, no new AI. |
| signature / compare; continuity observations | PairedReturnPlayer, ContinuityCompare | Tools / Compare; preserve both source identities, unavailable states and permitted append-only observations. |
| signature / case | CasePacketPreview, RecipientExportPanel, signature workflows | Tools / Build case packet; actual MISSING_CONTENTS, WRONG_ITEM, CONDITION_RETURN choices, permitted fields/media, factual notes, preview and explicit export. |
| signature / history | ItemHistoryPanel | Tools / Item history; view, share selected, open shared; current recipient/consent/expiry checks and anti-enumeration controls preserved. |
| invite, invitation | InviteScreen, InvitationReviewScreen | Details / People; promote only if actually blocking. Account-targeted invitation and explicit acceptance remain separate. |
| sharing | SharingScreen, SharedTrackingScreen | Explicit Share options; private/public audience and existing access checks unchanged. |
| receipt | CommerceReceiptScreen | Permitted receipt/return action; separate stage manifests, participant grants and recording requirements. |
| editPurchase, editShipping, event | EditDetailsScreen, EventDetailScreen | Details / Order and shipment / Activity; imported-field protection, corrections, source labels and exact event actors retained. |
| supporting: responses, retention, privacy | SupportingToolsScreen | Details / Record handling; append-only corrections, preservation notices and permitted private copies. |
| technical metadata, research/capture receipts | TechnicalDetailsSheet, CaptureReceiptPanel, ResearchPanel | Details / Advanced; preserve every field, permission and export; experimental features stay gated. |
| activity | ActivityScreen, UploadRecoveryCards, SavedPhotoDraft | Updates and exact pending original recovery; no duplicate file/task ownership or destructive cleanup. |
| account, dev | AccountScreen, DevToolsScreen | Existing profile, billing, notifications, channels, recordings, appearance, help, privacy, advanced and authorized developer tools. |

## Independent safety fix

`theme/capture-feedback.ts` issues scoped silence leases and revision-bound permits. `NativeCaptureHost.start` acquires a lease synchronously before invoking either camera implementation and releases it in `finally` after its recording promise settles. `haptics.ts` checks a permit before and after asynchronous system availability/module loading. Thus barcode feedback, a stop-button press and an unrelated pending completion haptic cannot vibrate during capture. Starting and stopping a recording invalidates old pending feedback even after the gate reopens. This is intentionally conservative; a stop acknowledgment while the lease is active may be silent, with visible state still available.

The native module remains responsible for recorder completion and hardware cleanup. No policy, captured bytes, source association, attestation or commit logic is changed. Actual vibration and device lifecycle behavior still need physical testing.

## Candidate design contract

Paper/canvas `#FAFAF8/#F1F2F0`; ink/secondary `#202724/#56615C`; blue `#245FC4`; green `#187153`; attention `#8C5A08`; danger `#AF303A`. Charcoal uses `#191D1B/#242A26` with separately checked foregrounds. All text remains scalable. Product touch controls are at least 48 CSS units in the candidate; native dp validation is still required.

The reference is `docs/proof-navigation-2026-09-08/acceptance/screenshots/proof-unrecorded-390.jpg` and historic `cc8209d:web/src/site/brand-palette.css`. That earlier palette included beige and muted slate; it is historical evidence, not the proposed new palette. The exact original Zite appearance could not be verified. Existing brand SVG paths and licensed Inter assets are reused unchanged.

Motion is short and event-driven: 240 ms task entry, 260 ms accepted-row acknowledgment, 180 ms measured-progress change. System reduced motion is observed dynamically; the review control can demonstrate the no-travel alternative. No event timer simulates successful upload, and no animation callback mutates the domain. The prototype is not wired into production.
