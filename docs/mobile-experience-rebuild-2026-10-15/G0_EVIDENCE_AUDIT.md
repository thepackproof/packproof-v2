# PackProof mobile evidence and recovery audit — G0 / G1 input

Date: 15 October 2026. Source baseline: `e71461caae5075adaa7b741a3ceec3cd2d9b7d3a` in `packproof-v2`. Scope: static source review and existing local model/harness tests. This is an audit of the checked-out source, not verification of the currently installed Android release or live server configuration.

The attached master plan requires an explicit founder G1 decision before production UI work. No production code, evidence rules, billing policies, cloud configuration or store release was changed in this audit. No credentials, private account data or production systems were accessed.

## 1. Executive findings

1. **Reuse the existing evidence pipeline.** The repository already has a durable, account-scoped capture journal and a shared completion coordinator. A UI rebuild must compose over these owners; a second upload/finalization state machine would increase risk.
2. **The ordinary manual seller flow needs one continuous packing video and explicit native biometric confirmation.** No default mandatory supplemental item photographs or buyer invitation were found in that flow. Grading and receiving recipes have distinct required photo slots and must remain reachable.
3. **Preflight is real and must remain before physical packing.** Capability compatibility, device biometric availability/key setup, storage, permission, server capture admission and account limits precede the recorder. A new manual Proof requires connectivity; reviewing an already saved video can be available offline.
4. **Server-finalized, committed and durably preserved are different.** In an explicitly compatible server mode, canonical finalization can succeed before durable recovery receipts; local phase remains `SUBMITTED`, and the original cannot be cleaned up. Never flatten these conditions to upload percentage or a green check.
5. **104 existing tests passed locally** across 14 suites, including recovery, lost responses, account scoping, upload handoff, draft idempotency and task routing. This does not pass the plan's physical Android, TalkBack, actual biometric, two-device or force-stop acceptance gates.
6. **Runtime flags and installed-build provenance remain unverified.** Source defaults and build-profile assertions are not evidence of deployed settings. The production receipt mode, capture-engine mode, intake contract and account entitlement must be read from the authorized target environment during later QA.

## 2. Authority map

All paths below are repository-relative. Line references apply to the audited commit.

| Concern | Authority and source | Rebuild constraint |
|---|---|---|
| Canonical state | `docs/architecture.md`: canonical PostgreSQL state, object-store evidence; `backend/src/domain/finalize.ts:100–140,205–233,415–448` | UI represents returned state; it cannot assign finalization. |
| Ordinary participation | `backend/src/domain/participation.ts:10–21`; `backend/src/domain/finalize-requirements.ts:52–107` | Default `COUNTERPARTY_OPTIONAL`; explicitly stored required-counterparty policy still waits for the buyer. |
| Capture authorization | `backend/src/domain/capture-sessions.ts:91–117,147–174` | Seller-only ordinary capture; no capture on finalized Proofs; stage-specific buyer/seller authorization preserved. |
| Capture admission and limits | `backend/src/domain/capture-sessions.ts:119–129,164–170`; `backend/src/billing/capture-allowance.ts:9–43` | Pause controls, allowed parcel shape, queue limit, pinned intake context and billing allowance must be checked before recording. |
| Evidence creation | `backend/src/domain/evidence.ts:67–126,132–180` | Authorized participant and evidence type; stable idempotency; exact session ownership; no reuse of a committed upload URL. |
| Evidence commitment | `backend/src/domain/evidence.ts:254–348` | Independently computed SHA-256 and size/codec checks; match recording registration; bind immutable committed storage identity. |
| Finalization | `backend/src/domain/finalize.ts:112–138,164–220`; `backend/src/domain/finalize-requirements.ts:30–107` | Seller-only; replay returns same manifest; no pending evidence; qualifying fulfillment capture and seller packing statement required. |
| Signed declaration | `mobile/src/attestation/statement.ts:1–2`; `mobile/src/attestation/seller-attestation.ts:7–60`; `backend/src/domain/attestation-authorization.ts:16,94–131` | Exact statement/version; deliberate secure device signature tied to actor, Proof, session and hash; no automatic consent. |
| Local workflow | `mobile/src/capture/recovery-model.ts:1–34`; `mobile/src/capture/completion.ts:25–32,73–132` | Local phase is never canonical Proof status; one journal owner, same account/server, same operation identity. |
| Reconciliation | `mobile/src/capture/recover-completion.ts:31–117` | Read exact Proof and recovery state before reissuing writes; retain local original on conflict or uncertainty. |
| Source deletion | `mobile/src/capture/recovery-model.ts:63–70`; `mobile/src/capture.ts:461–486` | Automatic success is not deletion authority; cleanup requires receipts, deliberate discard has separate guards. |
| Immutability | `backend/migrations/001_init.sql:132–203`; `backend/migrations/018_committed_evidence_immutability.sql:1–16` | DB rejects finalized Proof mutation, committed evidence mutation/deletion and manifest/audit mutation. |

## 3. Verified ordinary manual journey

### 3.1 Creation and prerequisites

`mobile/src/screens/ManualCreateScreen.tsx:61–67,167–171` requires a nonempty item title in the current UI. Quantity/currency initialize to 1/USD at lines 22–26. Description, order reference, dates, quantity/value and shipping details are optional disclosures. No recipient/account-invite field is required in this form. `mobile/src/copy/forms.ts:85–118` converts blank optional metadata to null.

`mobile/src/app/PackProofProvider.tsx:1809–1861` serializes creation, requires connectivity, persists the exact operation and idempotency key before the request, creates/reopens its transaction and Proof, then routes to capture. An uncertain create cannot silently become a different transaction (`mobile/src/experience/manual-operation.ts:3–6`). The prototype may shorten composition but must retain draft recovery and existing validation.

Before frames are recorded, `mobile/src/capture.ts:128–170` executes preflight, asks camera permission, checks current account, obtains an authorized server capture session, validates its state/expiry, applies server recording limits and writes the account/session binding. This is not an offline-from-scratch capture promise. A previously authorized recording can survive a subsequent network loss.

`mobile/src/capture/preflight.ts:7–25` checks:

- Recoverable unified camera availability.
- Compatible capability schema, capture protocol, limits and receipt support.
- Supported native seller-attestation method and shipping/context capability contract.
- Available biometrics and account-scoped key preparation for an ordinary seller take.
- Free disk reserve of `min(server maxBytes, 250,000,000) + 32 MiB`.

`mobile/src/capture/capabilities.ts:15–37` fails closed on unsupported/malformed capabilities. Its shipping contract explicitly permits no label but requires handling observed conflicts. The actual camera permission is requested after these checks (`mobile/src/capture.ts:129`). These prerequisites should appear as focused recovery when blocked, with the item draft retained.

### 3.2 Video, photographs and labels

The normal native packing path records a continuous take. Retakes are separate takes; the current review confirmation says they are never joined (`mobile/src/screens/CaptureScreen.tsx:231` and surrounding handler). Replacement deletes an old unsubmitted take only after the new take is saved (`mobile/src/app/PackProofProvider.tsx:2131–2135`).

Recipe requirements, from `backend/src/domain/capture-recipes.ts:26–64`:

| Recipe | Required | Optional | Scope |
|---|---|---|---|
| `PACKING_STANDARD_V1` | Packing video | Label image | Packing/return-packing recipe; no mandatory item photo ritual. |
| `CARD_STANDARD_V1` | Front and back images | None | Separate item-documentation/grading workflow. |
| `CARD_DETAILED_V1` | Front and back images | Corners, surface video | Detailed item-documentation workflow. |
| `RECEIPT_STANDARD_V1` | Package, item front, item back images | None | Separate recipe-based receiving/intake workflow. |

Ordinary fulfillment still uses the existing native `FULFILLMENT_CAPTURE` session path; these recipe definitions do not authorize substituting photos for that video. In particular, a generic recipe table is not a reason to inject every recipe's images into initial packing.

No tracking label is necessary for ordinary completion. An observed code conflict can require a decision before signing/finalization: `mobile/src/capture/capabilities.ts:33–37`, `mobile/src/capture/completion.ts:48–60`, `backend/src/domain/finalize.ts:184`. The design must distinguish “no label found” from “a conflicting observed label requires review.”

### 3.3 Exact declaration and authorization

Required native user-facing statement, version 1:

> The item shown and attached in this Proof is the item I am shipping

Source: `mobile/src/attestation/statement.ts:1–2`, matching the backend constant. Do not rewrite this statement as a paraphrase in the production authorization flow without separate policy review.

Current review CTA is **Confirm and submit**. `mobile/src/ui/SellerAttestation.tsx:17–27` exposes the statement and explains the secure biometric prompt. `mobile/src/attestation/seller-attestation.ts:10–48` binds to the original user/Proof/session, validates the server challenge, invokes signing, persists the exact signature before the request, and recovers an accepted prior authorization after a lost response. Cancellation must retain the saved recording.

The client checks challenge actor, Proof, session, source hash, optional capture-manifest hash, public-key digest, exact statement, nonce and expiry (`mobile/src/attestation/authorization.ts:11–25`). No prototype checkbox or simulated authentication constitutes an actual signed declaration.

**Policy distinction requiring careful wording:** native mobile explicitly requires biometric authorization. The generic backend attestation endpoint accepts optional `authorization`; supplied authorization is verified (`backend/src/domain/attestations.ts:110–129`). The general finalization predicate checks the seller's packing statement, with exact evidence linkage additionally enforced in durable-receipt mode (`backend/src/domain/finalize.ts:191–197`). It does not impose one universal biometric requirement for every API/legacy surface. Preserve native signing and record this as a cross-surface policy question; do not claim the server universally enforces biometric use or silently change backend compatibility during UX work.

### 3.4 Billing and intake are conditional server gates

`backend/src/billing/capture-allowance.ts:9–43` verifies the seller, locks the user row and reuses an existing immutable per-Proof reservation. For a current enrolled offer, the server applies its byte/duration limits and allowance. Reservations, recorded usage and already finalized Proofs are unioned to avoid counting a Proof twice. A past enrolled offer with no current period requires renewal; an exhausted active allowance blocks a new reservation. A user with no past/current enrolled period retains the ordinary unenforced pilot workflow in this source.

Existing recovery/reservations are not a reason to force a new purchase. The prototype should explicitly identify its fixture as an authenticated eligible seller; include a separate server-denied preflight state. Neither a mandatory purchase nor universally free usage can be inferred for the live account.

`backend/src/domain/capture-sessions.ts:151–165` and `backend/src/intake/context.ts:260–263` preserve the pinned intake contract. If a Proof has contract version 1 and lacks an approved snapshot, prepared order readiness must be resolved first. Imported-order lifecycle checks are different from ordinary manual capture; no new generic recipient requirement should be invented.

## 4. Durability, recovery and truth in status

### 4.1 Original media ownership and process death

`mobile/src/capture.ts:168–170` writes an account-bound journal before acquisition. `persistLocalCapture` retains the unique native file or copies a temporary original into app document storage, checks nonzero size and writes metadata before emitting the local-save milestone (`369–393`). Metadata writes are serialized by operation and use temporary-file moves (`396–417`).

On relaunch, `listAccountCaptures` filters both user and normalized API origin before loading media (`425–450`). A journal left in `RECORDING` becomes a reviewable local take only when the native completion marker confirms positive duration and byte size. An unfinished file remains incomplete; it is not represented as a continuous playable take merely because bytes exist.

The Android recorder flushes/syncs and renames the native completion marker only after valid finalization (`mobile/modules/packproof-unified-camera/android/src/main/java/com/packproof/unifiedcamera/UnifiedCameraView.kt:365–397`). It retains surviving bytes on failure. The comment explicitly acknowledges that force-stop during active MP4 encoding can leave an unfinished tail; incremental recording-media recovery is not promised. Physical force-stop testing is still required.

The host marks background interruption and stops the recorder (`mobile/src/ui/NativeCaptureHost.tsx:252–261`); native lifecycle pause also interrupts/releases (`UnifiedCameraView.kt:118–120`). Existing Android Back routing is in `mobile/src/app/Root.tsx:115–128`. Code presence alone does not establish no-loss behavior on every device or OS lifecycle sequence.

### 4.2 One coordinator and stable identities

`prepareSavedCapture` performs deliberate authorization, persists `submitRequested` and `UPLOAD_QUEUED`, and does not send video bytes (`mobile/src/capture/completion.ts:36–70`). The screen may then yield to Home while the journal remains the owner (`mobile/src/app/PackProofProvider.tsx:2173–2188`). The next design must not show “complete” at this point.

`completeSavedCapture` deduplicates in-flight work by operation ID and limits concurrent completion work to two (`completion.ts:73–90`). `recoverCaptureCompletion` reads Proof/recovery before writes, persists each phase before its side effect, reuses the evidence idempotency key, rejects a different returned evidence identity, skips an already committed exact recording and reconciles lost commit/declaration/finalize responses (`recover-completion.ts:31–102`).

The retry owner is above screens and wakes on foreground/connectivity/timer changes (`mobile/src/app/PackProofProvider.tsx:1242–1314`). JavaScript may be suspended while backgrounded, so copy should promise durable retention and retry when eligible, not uninterrupted background progress on every device.

### 4.3 Transfer, commitment and finalization

| Milestone | Truth source | Allowed meaning |
|---|---|---|
| Local saved | Nonzero original + persisted local journal | Original is on this device. No server success claimed. |
| Queued | Deliberate submit intent persisted | Waiting to transfer; server may not have bytes. |
| Uploading | Active transfer progress | Bytes are moving. 100% is not finalization. |
| Bytes received | Successful transfer/part assembly | Server still must commit/validate the exact original. |
| Evidence committed | Refreshed server evidence row `COMMITTED` | Server accepted this original; other requirements may remain. |
| Preservation pending | Recovery service lacks durable receipt | Keep local original; retry reconciliation. |
| Confirmation needed | Explicit authorization absent/expired/rejected | Ask for deliberate confirmation; do not re-record automatically. |
| Finalization pending | Finalize requested, authoritative completion not verified | Keep local original; no completed claim. |
| Canonically finalized / local `SUBMITTED` | Compatible server reports final Proof plus exact committed evidence; real durable receipts still absent | Proof is submitted/finalized at server, local copy retained until preservation confirmed. |
| Local `FINALIZED` | Same exact evidence and finalization have durable receipts | Completed; existing explicit cleanup policy may permit local removal. |

Sources: `mobile/src/capture/recovery-model.ts:35–70`, `mobile/src/capture/upload-recovery.ts:1–25`, `mobile/src/capture/recover-completion.ts:48–100`, `mobile/src/capture/upload-outcome.ts:3–7`.

The server decides whether durable receipts are required for finalization (`backend/src/config.ts:125`, `backend/src/app.ts:391,1866`). The client reevaluates capabilities every recovery attempt and defaults strict if unknown/malformed (`mobile/src/capture/capabilities.ts:3–12`). If the server explicitly reports compatible `durableReceiptsRequired=false`, canonical submission may finish with local `SUBMITTED`; **cleanup still requires both actual receipts**, never the permissive capability alone.

### 4.4 Retry, expired authorization and account changes

- Direct uploads use server-issued HTTPS targets, progress remains below completion until the transfer finishes, and a 90-second no-progress watchdog turns stalls into recoverable errors (`mobile/src/capture/upload-transport.ts:17–27`; `mobile/src/capture.ts:530–578`). An expired external target is mapped to retryable `UPLOAD_URL_EXPIRED`.
- Resumable transfer asks the server which 5 MiB parts already exist, sends missing parts, deletes temporary chunks only, then assembles (`mobile/src/capture.ts:607–655`). The original is not deleted by transfer completion.
- Backend part upload verifies ownership, bounds and exact digest for replayed part numbers (`backend/src/domain/resumable-upload.ts:66–155`). Part completion does not itself finalize a Proof.
- `recoveryRetry` separates auth/intervention from transient retry and uses bounded backoff (`mobile/src/capture/recovery-model.ts:53–61`). No automatic fresh biometric consent occurs in a background retry. An expired required challenge leads to “confirm again,” with media kept (`recover-completion.ts:72–81`).
- The provider refreshes an eligible Cognito session before queued work and guards context before/after effects (`PackProofProvider.tsx:917–945,1289–1307`). `assertCaptureAccount` requires original user/API/token (`mobile/src/v2-api.ts:666–670`). Saved journals and photo drafts are filtered by account and API origin. Physical mid-transfer account switching remains untested here.
- If another device finalized with the same evidence, reconcile; if a different original finalized the Proof, raise `CAPTURE_ORIGINAL_CONFLICT` and keep the local original (`recover-completion.ts:49–52`). No mutation of the finalized record is attempted.

## 5. Flags and rollback inventory

| Control | Source behavior | What remains unknown |
|---|---|---|
| `EXPO_PUBLIC_PACKPROOF_MOBILE_TASK_UX` | Build-time composition enabled unless exactly `"false"`; `mobile/src/experience/mobile-ux.ts:1–2`. Used by shell, Home, lists, account and route adapters. | Value compiled into installed release; complete rollback screen parity on device. |
| `EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE` | Enabled only at `"true"`; flow version 1; `mobile/src/experience/first-proof.ts:1–3`. | Installed build value; it also affects signup/onboarding presentation, so keep separately accounted. |
| `EXPO_PUBLIC_PACKPROOF_CAPTURE_ENGINE` | Enabled at `"1"`; `mobile/src/capture/engine.ts:15`. Affects capture-session manifest/journal path. | Installed binary value and server support. **Do not use this as a UX rollback switch.** |
| `PACKPROOF_REQUIRE_DURABLE_RECEIPTS` | Server runtime configuration; source default false (`backend/src/config.ts:125`). Exposed through capabilities. | Actual authorized target environment value. Never change to make UI look complete. |
| `NEW_CAPTURE_PAUSED` | Server DB pause control; missing control fails closed (`backend/src/admin/flags.ts:3–11`). | Live value. Existing recovery must continue. |
| Research/capture receipts | Separate production/lab flags and isolation (`mobile/src/runtime-config.ts:131–158`). | Whether an optional capture receipt is enabled for a particular account/session. |

Existing route adapter examples: `PackProofProvider.tsx:526–529` remaps scan when mobile task UI is off and recordings to Updates when on. Saved task intents preserve their flow identity across version 0/1 and scope keys by user/API (covered by `first-proof-intent.test.ts`). These are useful compatibility foundations, not a completed pending-upload rollback rehearsal.

Proposed later rollback rehearsal: on the exact internal candidate, create one locally saved unsigned take, one deliberately submitted stalled upload and one committed-but-not-finalized job; record user/API/session/evidence identities in secure QA; switch only the new presentation control; relaunch; confirm all three appear through a known old route, retain bytes and resume exactly once. Repeat with account switching and a finalized conflict. No public rollout before G4.

## 6. Tests executed and limits

Final command, from the repository root:

```bash
node --import ../test-deps/node_modules/tsx/dist/loader.mjs --test \
  mobile/tests/capture-recovery.test.ts \
  mobile/tests/capture-limits.test.ts \
  mobile/tests/first-proof-intent.test.ts \
  mobile/tests/manual-operation.test.ts \
  mobile/tests/photo-drafts.test.ts \
  mobile/tests/recovery-workspace.test.ts \
  mobile/tests/task-home.test.ts \
  mobile/tests/workspace-summary.test.ts \
  mobile/tests/proof-navigation.test.ts \
  mobile/tests/mobile-ux-events.test.ts \
  mobile/tests/upload-recovery-card.test.ts \
  mobile/tests/activity-model.test.ts \
  mobile/tests/mobile-ux-build-profile.test.cjs \
  mobile/tests/upload-handoff.test.ts
```

Result: **104 tests; 104 pass; 0 fail; 0 skipped.** Exit 0. Node v24.19.0. Full output: `audit-model-tests-final.log` in the task workspace. These are existing repository tests, with no implementation or test edits. Their mock/harness boundaries exclude the real camera, filesystem, key store, network service, database and device lifecycle where applicable.

The original checkout had no installed backend/mobile toolchain. Initial native-strip runs showed successful available model checks but could not load suites needing `@noble/hashes` or TypeScript transformation. A later run with isolated small scratch dependencies passed 103 tests and failed one child-process check because that test hardcodes `backend/node_modules/tsx/dist/loader.mjs`. An ignored local loader link to the same isolated dependency resolved that environment-only failure; the final rerun passed all 104. No source changes were made to suppress errors. Logs from earlier attempts are retained as diagnostic history; they do not supersede the final result.

Tests give concrete evidence for: lost commit/declaration/finalize response reconciliation; retained media without durable receipts; strict malformed capability handling; exact source conflict; account scoping; retry classification; saved photo continuation; prevention of duplicate create; action priority and deduplication; stale-state refresh; permission gating; safe event dimensions; source-backed build-flag assertions; and nonblocking handoff from review to the upload owner.

Not executed: full backend/database/integration suite, mobile typecheck/build/lint, Android compilation/install, physical biometric prompt, real storage pressure, real network/auth expiration, two-device race, force-stop recovery, TalkBack, switch input, hardware Back, font-scale layout, performance baseline and feature-toggle queue rehearsal. No runtime or device pass is inferred from model success.

## 7. Acceptance B01–B15 — honest status

Every physical/release result below is **NOT RUN**. “Model evidence” identifies narrower supporting checks and is not a substitute for the specified scenario.

| ID | Required scenario | Local evidence | Physical/release result and remaining verification |
|---|---|---|---|
| B01 | Offline before upload; later online | Passing recovery and queue models; source retains original and journals intent. | **NOT RUN.** Lose network after save/authorization, relaunch if needed, restore network and verify same accepted original. |
| B02 | Force-stop during/after save | Source completion marker and incomplete-take guards; task model rejects incomplete footage. | **NOT RUN.** Force-stop at encoder, marker write, journal write and post-save points on physical Android; distinguish incomplete bytes from playable complete take. |
| B03 | Expired auth/upload token mid-transfer | Passing recovery retry/account models; direct URL expiry mapping and bounded parts reviewed. | **NOT RUN.** Expire actual bearer and upload target independently; retain operation/account and resume without duplicate evidence. |
| B04 | Double submit, timeout, retry | Passing stable-create and lost-response recovery tests; coordinator dedup; source per-Proof billing reservation. | **NOT RUN.** Real UI double taps and actual lost responses; inspect server evidence/finalization/usage counts. Billing no-double-charge not integration-tested here. |
| B05 | Hash mismatch or rejected attestation | Server independent digest checks reviewed; rejection retains recovery state; authorization/recovery models pass. | **NOT RUN.** Inject mismatched bytes and rejected signed authorization against sandbox; verify no success and retained original. |
| B06 | Other-device finalization | Passing recovery exact-original conflict and authoritative task invalidation models. | **NOT RUN.** Two devices finalize same/different capture scenarios; no mutation or false completion. |
| B07 | Account switch with queued upload | Passing account/server-scoping tests; per-effect checks and list filtering reviewed. | **NOT RUN.** Switch during actual transfer, signing and resume; verify both accounts and file access remain isolated. |
| B08 | Low disk or denied camera | Capture-limit models pass; preflight checks and preservation logic reviewed. | **NOT RUN.** Actual no-space/permission-denied tests with retained draft and accurate no-save state. |
| B09 | Android Back/Home during recording/review | Existing handlers and native interruption path reviewed. | **NOT RUN.** Exercise physical Back, Home, interruption and return with keyboard/safe-area states. |
| B10 | Seller/counterparty-stage lifecycle | Source server role, workflow and finalize requirements reviewed; client route/role models pass. | **NOT RUN.** Full backend lifecycle/permission integration tests and actual invited buyer/stage UI still required. |
| B11 | 320/360/393/411 dp × 1.0/1.3/2.0 | No native layout test in this evidence audit; prototype rendering is separate design evidence. | **NOT RUN.** Exact candidate build at every requested viewport/theme/font combination. |
| B12 | TalkBack, keyboard/switch navigation | Existing semantics visible in source, not device verified. | **NOT RUN.** Focus order, names, announcements, touch size and alternate input on actual candidate. |
| B13 | Long/RTL-like strings, locales | No native visual result claimed. | **NOT RUN.** Seed explicit fixtures and verify wrapping, accessible full label and time formatting. |
| B14 | Offline/slow/empty/loading/error | Passing task/activity/upload copy models; timeout/watchdog code reviewed. | **NOT RUN.** Actual screen/network sequence, stable placeholders and finite recovery on candidate. |
| B15 | Presentation rollback with queued uploads | Passing task-intent version compatibility and build-profile assertions; same journal owners reviewed. | **NOT RUN.** Install/switch/relaunch exact candidate with queued, committed and unsigned originals; compare identities and bytes. |

## 8. Decision log and release risks

| ID | Classification | Finding or decision | Owner / required next action |
|---|---|---|---|
| E01 | Verified design constraint | Native seller biometric declaration is part of current workflow. | Design: show requirement before recording and exact statement at review. Engineering: reuse existing signing coordinator. |
| E02 | Verified design constraint | Normal packing has no default mandatory item photographs or recipient invitation. | Design: keep default short; route grading/receiving required images only when server workflow calls for them. |
| E03 | Runtime unknown | Receipt mode, capture-engine flag, active intake contract and live entitlements are not known. | Engineering/QA: capture non-sensitive capability/build snapshot from authorized sandbox during G2; do not infer from source defaults. |
| E04 | Policy distinction | Generic backend authorization is optional across surfaces, while native submission requires signed biometric confirmation. | Product/backend owner: clarify intended cross-surface statement policy separately. Preserve current native behavior; no backend edit in UX scope. |
| E05 | Unverified device risk | Native process death can leave incomplete MP4; no incremental-media guarantee. | QA: B02 across specified physical devices; ensure incomplete take never receives success or gets silently deleted. |
| E06 | Unverified device risk | Background JavaScript suspension can delay queued work despite durable persistence. | Design: honest queued/retry copy. QA: background/resume/network matrix. |
| E07 | Unverified release risk | Existing UI rollback flags do not prove upload survival in a new candidate. | Engineering/QA: preserve shared coordinator and rehearse B15 before G4. |
| E08 | Verified architecture opportunity | Durable coordinator, account guards, common task models and meaningful tests already exist. | Engineering after G1: compose/adapt these owners rather than duplicate them. |
| E09 | G0 evidence gap | Installed release identity, baseline on-device recordings, actual runtime settings and physical QA evidence are not supplied by this checkout. | Founder/QA: provide or capture authorized sanitized evidence. Keep G0 device baseline explicitly incomplete. |

No data-state or integrity defect is asserted solely from founder screenshots. The findings above distinguish inspected source, executed local tests, design choices and unverified runtime/device behavior.

## 9. Constraints sent to the prototype owner

- Use an explicitly labelled authenticated, eligible seller fixture, with optional marketplace setup.
- Require item title; keep optional metadata disclosed; manual creation starts online.
- Preflight camera, biometric, storage and server allowance before recording. Include blocked states without inventing entitlement.
- One continuous packing video, then actual recording review. Do not insert mandatory photos into the ordinary path.
- Display the exact version-1 seller statement and a simulated biometric step clearly identified as a prototype, never actual security execution.
- Keep saved, queued, transferring, server accepted and finalized distinct; display a preserved local recording through failed/retried submission.
- No-label is permitted; observed conflict review is conditional.
- Resume the same Proof/job after interruption; do not silently create a new Proof or show interrupted incomplete bytes as usable evidence.
- Existing grading, receiving, returns, witness, exports, integration and advanced routes remain discoverable through authorized paths.

This audit supports G1 review; it does not authorize production screen implementation or public release.
