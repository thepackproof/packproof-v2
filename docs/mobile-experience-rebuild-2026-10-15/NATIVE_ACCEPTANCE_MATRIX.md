# Android task-first rebuild — native acceptance matrix

Prepared 2026-10-15 against the approved G1 design and the attached master implementation plan. This is an executable test protocol, not a signed acceptance result. **All physical-device, emulator, native accessibility, two-device and usability runs below are NOT RUN.** Passing TypeScript, model tests, a generated APK or a static prototype does not satisfy these checks.

## Build and run identity

Complete a separate run record for each artifact and device combination. Never copy results from one source SHA, policy configuration or signed artifact onto another.

Emulator runs are supplemental. The controlling plan requires physical Android acceptance; emulator screenshots or model tests cannot mark the physical-device rows PASS.

| Field | Value to record |
| --- | --- |
| Run ID / operator / UTC date | NOT RUN / unassigned / — |
| Source commit / clean tree | fbc1821ce687f95052d1e11df46e3cb55bff4977; clean before/after build |
| Artifact filename / SHA-256 | See `build-receipt.json` and `VERIFICATION_REPORT.md`; installed run NOT RUN |
| App version / Android versionCode | APK verified 1.0.1 (66); installed value NOT RUN |
| Signing scope / package ID | Local review: generated debug signing, `com.packproof.mobile`; verify receipt |
| Backend environment / policy configuration | Record non-secret environment label and required policy flags; no credentials |
| Device model / Android API / physical or emulator | NOT RUN |
| Window width / font scale / theme / display size | Record exact configuration for each run |
| Account fixtures / role | Use anonymous fixture aliases only |
| Evidence | Redacted video, screenshots, approved diagnostic output, observed server outcome |
| Overall result / defects | NOT RUN; no acceptance claimed |

The local review artifact is for a **clean spare ARM64 device or x86_64 emulator**. Its debug signing cannot replace a Play-installed app with a different signing key. Do not uninstall a production app or clear its storage to make room for this test: it may contain irreplaceable local recordings. The review profile disables optional research receipt functionality while the production profile enables it. A production-equivalent, authorized internal artifact and receipt-enabled run are required before G4; a receipt-disabled review alone cannot establish parity.

## Fixture preparation and evidence rules

Use a non-sensitive sandbox item and authorized test accounts. Prepare a fresh seller, a returning seller with mixed states, a buyer invite, a receiving-stage participant, a removed/unauthorized participant, a connected-order queue, and an account with a required supplementary-photo policy. Record fixture aliases in a restricted run record. Keep emails, tracking numbers, addresses, access tokens, file hashes and private order references out of published screenshots and event payloads.

Prepare distinct states for: unsaved draft; valid local original awaiting review; queued upload; active upload; delayed retry; action-required failure; server-received media awaiting finalization; finalized Proof with a retained original; and an interrupted/invalid recording. Never manufacture a production failure or alter production evidence to produce a fixture. Use an isolated authorized test environment for server rejection, expiry and timeout scenarios.

Every row below starts **NOT RUN**. To mark PASS, append a result record containing the test ID, run ID, device/API, theme, width, font scale, source/artifact identity, actual outcome and evidence link. A screenshot of a label is insufficient evidence of durable media, server acceptance, finalization or successful upload recovery.

## A — product tasks and interface

| ID | Execute | Required observed result | Status |
| --- | --- | --- | --- |
| A01 | Fresh seller: launch Home, find the primary action, enter an item name, continue. Repeat without a connected selling account. | Manual start is discoverable; no mandatory marketplace setup or tutorial; one existing creation operation owns retries. | NOT RUN |
| A02 | Complete item → camera → one continuous recording → actual playback → declaration → authorized submit. Observe each upload/server state. | Recording starts only on deliberate tap. Review plays the saved original. The exact required statement begins unchecked. Native signing/biometric checks remain enforced. Finalized appears only after authoritative server result; optional photos do not block ordinary packing. | NOT RUN |
| A03 | Use a policy that requires supplementary photos; capture, retake and resume the required views. | Only applicable required views block completion; missing views cannot be bypassed; video continuity and evidence validation remain unchanged. | NOT RUN |
| A04 | Open the same unfinished Proof independently from Home, Proofs, an authorized notification and participant deep link. Repeat with locally saved media and after server state changes. | Each entry reaches the existing policy-allowed owner. Local review is preserved; no duplicate Proof, recording, submit or stale capture action. Intentional evidence/history viewers remain viewers. | NOT RUN |
| A05 | Open a finalized Proof with and without a retained local original. Inspect evidence, manifest and share actions. | No seller Continue recording action; evidence/manifest/share are permission-gated. Server finalization does not imply that a local original can be deleted. | NOT RUN |
| A06 | Open Capture with zero imported orders; use Pack an item. | Manual start works. Empty order search/filter furniture does not dominate the page. No automatic camera recording. | NOT RUN |
| A07 | Open Capture and Orders with many imported orders; search, change filters, return and scroll. | Compact queue remains usable; all results remain reachable; chips and labels do not clip; returning navigation restores intended context. | NOT RUN |
| A08 | Scan a known code, an unknown code, an ambiguous match and a code after denying camera permission. | Correct authorized match or explicit choice/fallback; manual entry remains possible; no silent duplicate creation or capture. | NOT RUN |
| A09 | Open Proofs with tracking absent and present. Add or amend tracking only where permitted. | Tracking stays optional for ordinary packing; source/provenance is clear; read-only records cannot be edited; carrier registration is not confused with carrier acceptance. | NOT RUN |
| A10 | Open History for a Proof with two events; expand each event and switch any available filters. | Events appear compactly in order, with timestamp/authorized actor and accessible expansion. Complete audit details remain reachable; no invented events or giant empty frame. | NOT RUN |
| A11 | As invited buyer, accepted buyer, removed participant and unrelated user, open the same relevant entry paths. | Only authorized information/actions are visible; the server enforces access; unauthorized local media never appears. | NOT RUN |
| A12 | Switch light/dark/system appearance; open and dismiss profile; visit Account, Settings, Integrations, Orders, Help and Advanced. | All capabilities remain reachable, state survives expected navigation, selection is clear, and dismissal restores meaningful focus. | NOT RUN |
| A13 | Use a production-equivalent internal build with optional advanced capture receipt enabled; discover it, exercise its choice/consent and complete a supported capture. Also test disabled/unavailable policy. | Receipt functionality and consent remain intact and discoverable under Advanced; ordinary task focus stays clear; required signing preflight is never skipped. The receipt-disabled local review cannot pass this row. | NOT RUN |
| A14 | At a valid stage, find and perform the authorized handoff action; repeat before that stage and as the wrong role. | Short valid path; invalid roles/stages cannot hand off. Handoff does not claim carrier acceptance or delivery. | NOT RUN |
| A15 | Mixed account: own draft, pending invitation, saved review, passive upload, waiting counterparty and finalized record. Refresh while focusing the hero. | Own actionable work is prioritized by the canonical selector; hero and short attention list do not duplicate a Proof; passive waiting is not urgent work; focused recommendation changes only when invalidated. | NOT RUN |

## B — integrity, recovery and accessibility

| ID | Execute | Required observed result | Status |
| --- | --- | --- | --- |
| B01 | Disconnect before upload and during transfer; leave the app; reconnect and reopen Updates. | Original is durably retained; honest saved/queued/offline states; same job resumes without requiring a re-record; server acceptance is distinguished from finalization. | NOT RUN |
| B02 | Force-stop during recording, immediately after valid save, during upload and after server response; relaunch each time. | Valid saved state is restored exactly. Interrupted/incomplete media is never represented as continuous valid evidence. No source loss or duplicate submission. | NOT RUN |
| B03 | In an isolated test environment, expire authentication or the upload token during transfer; reauthenticate with the original account. | Same account, recording and operation resume; no leaked evidence, duplicate job or false success. An unrelated account cannot resume the original. | NOT RUN |
| B04 | Double-tap create/submit; inject a timeout after server acceptance; retry and restart. | One accepted operation and server result; no duplicate finalization or charge. Required consent/signing cannot be bypassed. | NOT RUN |
| B05 | Exercise a controlled hash mismatch and rejected/expired attestation. | No success/finalized state; actionable failure; original retained; correct policy requires reconfirmation when needed. | NOT RUN |
| B06 | On device A focus an unfinished Proof; finalize on device B; activate A's old action and resume its saved original. | A refreshes authority and shows the server-finalized record; no mutation or fresh capture of the finalized root; local original remains safely retained. | NOT RUN |
| B07 | Leave uploads pending, sign out, switch server/account, navigate all four tabs and deep-link, then return to original account. | No cross-account rows, files, timers, pending link application or evidence association; original-account work remains recoverable. | NOT RUN |
| B08 | Deny/revoke camera access; use low-storage fixture and unavailable-camera state before recording. | Clear preflight/recovery, preserved draft, no false recorded/saved state. A recovery button does not silently start recording. | NOT RUN |
| B09 | Press Android Back, go Home/background, rotate where supported, open keyboard and return during preparation, recording, review and submit. | No silent media loss; existing interruption behavior remains truthful; required controls remain visible above system/keyboard insets; recording/review route cannot be bypassed into duplicate work. | NOT RUN |
| B10 | Execute seller, buyer and counterparty-stage lifecycle, including stage-specific attestation and invalid role attempts. | Server role gates, required declaration/version and native signing requirements remain unchanged; receiving-stage work does not alter a finalized root record. | NOT RUN |
| B11 | Run every core screen at 320, 360, 393 and 411 dp, font scales 1.0, 1.3 and 2.0, both themes; capture first viewport and full scroll. | No clipped text, overlap, inaccessible controls or hidden essential action. Labels wrap; lists/sheets scroll; bottom tabs and camera HUD remain usable. Every required combination needs an evidence record. | NOT RUN |
| B12 | Complete A02 and B01 with TalkBack; exercise profile/filter/confirmation sheets, keyboard and switch navigation. | Logical focus, named actions, correct selected/disabled/busy states, meaningful focus return, touch areas at least 48 dp, and useful non-repeating progress announcements. Camera playback and mandatory declaration are operable. | NOT RUN |
| B13 | Use very long item/reference strings, email-shaped deliberately entered titles, RTL-like strings and varied locale/time formats. | Titles wrap or truncate gracefully while full accessible labels remain available; no participant email is invented as a title fallback; no control is pushed offscreen. | NOT RUN |
| B14 | Test offline startup, slow requests, zero history/orders, refresh error and loading→empty/error transitions. | Honest freshness and recovery; no endless spinner; stable skeleton/empty states; saved local review remains reachable; first-Proof copy is not shown for a merely filtered empty collection. | NOT RUN |
| B15 | With a valid queued original, rebuild the same compatible internal application with `EXPO_PUBLIC_PACKPROOF_ANDROID_TASK_FIRST=false`; reopen and resume. Re-enable the composition and repeat. | Rollback changes UI composition only; compatible persisted drafts, originals, intents and upload jobs survive; no orphaned queue or forced deletion. Use compatible test signing; do not replace a Play install with a debug artifact. | NOT RUN |

## Required recording and screenshot evidence

Record five distinct, complete and uncut physical-device videos: V01 first manual Proof; V02 existing Proof resume; V03 order/scan Packing Station; V04 offline plus force-stop recovery; V05 invited buyer/counterparty-stage lifecycle. V05 uses A11/B10 with A02 as seller setup, follows the authorized participant through the applicable required stage and server outcome, and preserves the finalized root. The plan's packet lists four recordings while its final checklist calls for five; the fifth existing journey is the conservative evidence interpretation, not a new product flow or double-counted seller recording. All five remain NOT RUN.

Associate start/end app identity and the observed server outcome with each run. Produce before/after screenshots matching S01–S09 on actual native builds, including both themes and the specified large-type/width cases. Existing G1 HTML/static atlases are design evidence only.

Supplement the A/B records with the following plan-specific evidence:

- At 360 dp and 1.0 font scale, show the primary resumable action and distinct manual Create Proof route in the first viewport; count at most three deliberate in-app decisions to manual recording, excluding required device permission/consent.
- Attach native component/screen fixtures in both themes, at 200% text, and relevant error/offline/empty states. Record 4.5:1 body and 3:1 large-text/meaningful-control contrast, 48 dp targets, and reduced-motion behavior without lost focus or capture interruption.
- Extend TalkBack and keyboard/switch checks to resume, order/scan, participant stage, evidence/history/shipment and account/integrations, using their existing run IDs.
- Change permitted material metadata during review and verify old confirmation is not reused. Switch evidence tabs and verify selected original, playback/scroll context and required steps remain correct.
- Extend the G0 capability ledger with current authorized routes, existing owners, run evidence and restrictions for receiving/return/witness/grading/photos/batch/orders/integrations/export/claims/API/account-billing/privacy/deletion. Do not test destructive actions on real accounts. Unavailable integrations must leave manual creation reachable.

**Native screenshot-diff CI is NOT IMPLEMENTED.** No approved native baseline or native screenshot comparison job exists yet. Capture and approve actual native fixtures, then add the explicit CI comparison gate required by the plan. Passing current source/model CI does not satisfy that requirement. All supplementary native evidence above is NOT RUN.

## G3 — unassisted usability

Use at least five target users unfamiliar with PackProof, including occasional sellers and repeat shippers. Obtain consent for observation and recording. Use non-sensitive sandbox fixtures and give no tutorial or coaching. Ask each to create a manual Proof, start and review packing capture, explain saved versus uploaded/finalized, find an unfinished Proof, and find optional tracking.

| Participant alias | Exact run / device | Manual start ≤15 seconds | First journey unassisted | Saved vs finalized correctly explained | Existing Proof / optional tracking | Time / wrong taps / evidence |
| --- | --- | --- | --- | --- | --- | --- |
| U01 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| U02 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| U03 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| U04 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |
| U05 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | — |

Proposed gates from the plan: 5/5 locate manual start within 15 seconds; at least 4/5 complete unassisted; 5/5 distinguish local save from server finalization; all remaining confusion corrected before G4; zero safety/accessibility blockers. Compare measured medians and wrong taps against an actual G0 baseline. If baseline measurements do not exist, report that gap; do not invent a regression percentage.

## Existing instrumentation and verification scope

| Mechanism | Existing source coverage | Privacy / interpretation limits |
| --- | --- | --- |
| Session UX aggregates | `analytics/mobile-ux-events.ts`: recommendation shown/selected, capture entry/durable save, review, upload recovery/intervention, commitment/finalization, draft exits and photo timing. Call sites remain in the existing Home, capture and completion owners. | Named counts and bounded numeric durations only; no persistence or transport. Clears on account/server switch. Session ratios and last-100-sample p95 are not unique-user conversion or a population performance baseline. |
| Consented native timing study | `analytics/native-study-core.ts`, `timing-bridge.ts`, `capture-measurement.ts`: actual capture ready/start/save/interruption, review/authorization, upload state, server completion, recovery and auth flow; coarse build/version/source/error context. | Existing explicit consent and dataset scope; current account and live consent are rechecked before transport. Domain locators remain local; payloads are projected onto an allowlist. Withdrawal/account-switch and real callback ordering require native-run verification. |
| Proposed follow-up only | If needed for local diagnosis, add named create-selection and permission/preflight-result counters at existing owner boundaries. | Closed enums only; no new transport, raw error messages, item content, order/Proof IDs, email, tracking, tokens, addresses or file hashes. Do not duplicate the consented timing pipeline or infer crash/background abandonment. |

Static code and unit tests verify the shape of these mechanisms. They do not establish measured native task duration, transport behavior on a real device, or a before/after usability improvement. Record actual observations in the run dossier.

## Release decision record

Any evidence loss, false finalization, hidden required declaration, unauthorized sharing, incorrectly scoped media, unrecoverable upload regression, obscured essential button or missing manual-start path is an unconditional NO-GO. Open defects require severity, owner, reproduction, affected exact artifact and retest evidence.

| Decision item | State |
| --- | --- |
| A01–A15 signed native results | NOT RUN |
| B01–B15 signed native results | NOT RUN |
| Production-equivalent optional receipt parity | NOT RUN |
| Native accessibility and responsive atlas | NOT RUN |
| Approved native screenshot baseline and CI difference gate | NOT IMPLEMENTED / baseline NOT RUN |
| Two-device concurrency and rollback rehearsal | NOT RUN |
| Five-user unassisted usability | NOT RUN |
| Measured G0/after performance comparison | NOT RUN |
| Founder watches videos and performs live task | NOT RUN |
| G4 exact-build production release authorization | NOT REQUESTED / NOT GRANTED |

G1 design approval authorizes this implementation work; it is not G4 release approval. Keep distribution internal until the required evidence exists and the founder explicitly approves the exact installable build.
